// kilocode_change - new file
import { OrgSchema } from "./schema"
import { OrgState } from "./state"
import { OrgArtifacts } from "./artifacts"
import { OrgPrompts } from "./prompts"

export namespace OrgRunner {
  export interface Deps {
    /** Look up accumulated cost of a chief's task session. Injected; DB-backed in tools.ts. */
    costOf: (taskID: string) => Promise<number | undefined>
  }

  export type Advance =
    | {
        kind: "instruct"
        stage: string
        chief: string
        taskPrompt: string
        /** Present when the same chief session should be resumed (revise / retry). */
        resumeTaskID?: string
      }
    | { kind: "gate"; stage: string; deliverablePath: string }
    | { kind: "incomplete"; stage: string; reason: string; resumeTaskID?: string }
    | { kind: "halted"; reason: string }
    | { kind: "done" }

  export function start(projectDir: string, org: OrgSchema.Organization, idea: string) {
    return OrgState.create(projectDir, org, idea)
  }

  function priorDeliverables(projectDir: string, org: OrgSchema.Organization, run: OrgState.Run, upto: string) {
    const priors: Array<{ stage: string; path: string }> = []
    for (const { stage } of org.pipeline) {
      if (stage === upto) break
      if (run.stages[stage]?.status === "completed") {
        priors.push({ stage, path: OrgArtifacts.deliverablePath(projectDir, run.runID, stage) })
      }
    }
    return priors
  }

  function instruct(
    projectDir: string,
    org: OrgSchema.Organization,
    run: OrgState.Run,
    stage: string,
    opts: { reviseNote?: string; resumeTaskID?: string } = {},
  ): Advance {
    const dept = org.departments[stage]
    return {
      kind: "instruct",
      stage,
      chief: dept.chief,
      resumeTaskID: opts.resumeTaskID,
      taskPrompt: OrgPrompts.stagePrompt({
        stage,
        idea: run.idea,
        deliverablePath: OrgArtifacts.deliverablePath(projectDir, run.runID, stage),
        workers: dept.workers,
        shared: org.shared,
        priorDeliverables: priorDeliverables(projectDir, org, run, stage),
        reviseNote: opts.reviseNote,
      }),
    }
  }

  export async function advance(
    deps: Deps,
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    input: { taskID?: string },
  ): Promise<Advance> {
    let run = await OrgState.read(projectDir, runID)
    if (run.status === "halted") return { kind: "halted", reason: run.haltReason ?? "run halted" }
    if (run.status === "completed") return { kind: "done" }

    // 1. A stage awaiting approval blocks everything until org_decision.
    const awaiting = org.pipeline.find(({ stage }) => run.stages[stage].status === "awaiting_approval")
    if (awaiting) {
      return {
        kind: "gate",
        stage: awaiting.stage,
        deliverablePath: OrgArtifacts.deliverablePath(projectDir, runID, awaiting.stage),
      }
    }

    // 2. A running stage: record taskID, then validate its deliverable.
    const running = org.pipeline.find(({ stage }) => run.stages[stage].status === "running")
    if (running) {
      const stage = running.stage
      if (input.taskID) {
        run = await OrgState.update(projectDir, runID, (s) => {
          s.stages[stage].taskID = input.taskID
        })
      }
      const record = run.stages[stage]
      // A revise decision pending on a running stage means: re-instruct the chief.
      if (record.decision === "revise") {
        const note = record.decisionNote
        const resume = record.taskID
        await OrgState.update(projectDir, runID, (s) => {
          s.stages[stage].decision = undefined
          s.stages[stage].decisionNote = undefined
          s.stages[stage].attempts += 1
        })
        return instruct(projectDir, org, run, stage, { reviseNote: note, resumeTaskID: resume })
      }
      const validation = await OrgArtifacts.validate(projectDir, runID, stage)
      if (!validation.ok) {
        return { kind: "incomplete", stage, reason: validation.reason, resumeTaskID: record.taskID }
      }
      const cost = record.taskID ? await deps.costOf(record.taskID) : undefined
      run = await OrgState.update(projectDir, runID, (s) => {
        s.stages[stage].completedAt = new Date().toISOString()
        if (cost !== undefined) s.stages[stage].cost = cost
        s.stages[stage].status = running.gate === "human" ? "awaiting_approval" : "completed"
      })
      if (running.gate === "human") {
        return { kind: "gate", stage, deliverablePath: OrgArtifacts.deliverablePath(projectDir, runID, stage) }
      }
    }

    // 3. Start the next pending stage.
    const next = org.pipeline.find(({ stage }) => run.stages[stage].status === "pending")
    if (next) {
      run = await OrgState.update(projectDir, runID, (s) => {
        s.stages[next.stage].status = "running"
        s.stages[next.stage].startedAt = new Date().toISOString()
        s.stages[next.stage].attempts += 1
      })
      return instruct(projectDir, org, run, next.stage)
    }

    // 4. Nothing pending, running, or gated: the run is complete.
    await OrgState.update(projectDir, runID, (s) => {
      s.status = "completed"
    })
    return { kind: "done" }
  }

  export async function decide(
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    decision: "approve" | "no-go" | "revise",
    note?: string,
  ): Promise<OrgState.Run> {
    const run = await OrgState.read(projectDir, runID)
    const gated = org.pipeline.find(({ stage }) => run.stages[stage].status === "awaiting_approval")
    if (!gated) throw new Error(`Cannot record decision "${decision}": no stage awaiting approval in run ${runID}`)
    return OrgState.update(projectDir, runID, (s) => {
      const record = s.stages[gated.stage]
      record.decision = decision
      record.decisionNote = note
      if (decision === "approve") {
        record.status = "completed"
      } else if (decision === "no-go") {
        record.status = "completed"
        s.status = "halted"
        s.haltReason = `no-go at ${gated.stage}${note ? `: ${note}` : ""}`
      } else {
        record.status = "running"
      }
    })
  }

  export async function status(projectDir: string, org: OrgSchema.Organization, runID: string) {
    const run = await OrgState.read(projectDir, runID)
    const totalCost = Object.values(run.stages).reduce((sum, s) => sum + (s.cost ?? 0), 0)
    return { run, totalCost, pipeline: org.pipeline.map(({ stage, gate }) => ({ stage, gate, ...run.stages[stage] })) }
  }
}
