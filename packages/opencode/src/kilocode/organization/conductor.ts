// kilocode_change - SP1 deterministic autonomous loop driver
import { OrgArtifacts } from "./artifacts"
import { OrgAudit } from "./audit"
import { OrgEvaluator } from "./evaluator"
import { OrgRunner } from "./runner"
import { OrgSchema } from "./schema"
import { OrgState } from "./state"

export namespace OrgConductor {
  export type EventType =
    | "stage_started"
    | "deliverable_settled"
    | "evaluator_verdict"
    | "revise_iteration"
    | "escalation"
    | "final_gate"
    | "completed"
    | "halted"

  export type Event = {
    type: EventType
    ts: number
    stage?: string
    detail?: string
    iteration?: number
    pass?: boolean
    taskID?: string
    cost?: number
  }

  export interface Deps {
    projectDir: string
    org: OrgSchema.Organization
    runnerDeps: OrgRunner.Deps
    spawnChief(input: {
      runID: string
      stage: string
      chief: string
      instruction: string
      resumeTaskID?: string
    }): Promise<{ taskID: string; cost: number; toolIDs?: string[] }>
    evaluate(input: { runID: string; stage: string; model: string; prompt: string }): Promise<string>
    readDeliverable?: (input: { runID: string; stage: string; path: string }) => Promise<string>
    now: () => number
    emit: (event: Event) => void
    /** Optional per-run transition lock shared with tool/HTTP mutations. */
    lock?: <A>(fn: () => Promise<A>) => Promise<A>
  }

  export type Outcome =
    | { type: "completed" }
    | { type: "halted"; reason: string }
    | { type: "paused"; kind: "escalation" | "final_gate" | "manual"; stage: string; detail: string }

  function instruction(taskPrompt: string, stage: OrgState.Stage): string {
    const criteria = stage.criteria ?? []
    if (criteria.length === 0) return taskPrompt
    return [
      taskPrompt,
      "",
      "Approved acceptance criteria (produce explicit evidence for every item):",
      ...criteria.map((criterion) => `- [ ] ${criterion}`),
    ].join("\n")
  }

  async function emit(deps: Deps, runID: string, event: Omit<Event, "ts">) {
    const full = { ...event, ts: deps.now() }
    deps.emit(full)
    const persist = () => OrgAudit.appendEvent(deps.projectDir, runID, full)
    await (deps.lock ? deps.lock(persist) : persist())
  }

  export async function drive(runID: string, deps: Deps): Promise<Outcome> {
    const loop = OrgSchema.resolveLoop(deps.org)
    let taskResults: Array<{ stage: string; taskID: string }> = []

    const escalate = async (stage: string, detail: string): Promise<Outcome> => {
      const pause = () =>
        OrgRunner.pause(deps.projectDir, deps.org, runID, {
          kind: "escalation",
          stage,
          detail,
        })
      await (deps.lock ? deps.lock(pause) : pause())
      await emit(deps, runID, { type: "escalation", stage, detail })
      return { type: "paused", kind: "escalation", stage, detail }
    }

    for (;;) {
      const advance = () => OrgRunner.advance(deps.runnerDeps, deps.projectDir, deps.org, runID, { taskResults })
      const batch = await (deps.lock ? deps.lock(advance) : advance())
      taskResults = []

      if (batch.halted) {
        await emit(deps, runID, { type: "halted", detail: batch.halted.reason })
        return { type: "halted", reason: batch.halted.reason }
      }
      if (batch.done) {
        await emit(deps, runID, { type: "completed" })
        return { type: "completed" }
      }
      if (batch.paused) return { type: "paused", ...batch.paused }

      if (batch.gate) {
        const stage = batch.gate.stage
        // kilocode_change - Finding: a budget-escalation gate carries a note (gateItemFor surfaces the
        // stage's escalationNote, which only a cumulative-cost threshold crossing sets — a declared
        // gate:"human" stage never does). It is a human FINANCIAL checkpoint, not an evaluator boundary.
        // Auto-approving it through the LLM evaluator would consume the once-per-run escalation flag with
        // no human review and let unattended spend continue to the hard ceiling — exactly what the
        // threshold exists to interrupt. Pause for a human even in autonomous mode; they resolve it via
        // org_decision (approve to continue / no-go / revise), same as the non-autonomous gate path.
        if (batch.gate.note) {
          return escalate(stage, batch.gate.note)
        }
        const run = await OrgState.read(deps.projectDir, runID)
        if (run.auto !== true) {
          const detail = "run reached a human gate outside autonomous mode"
          const pause = () =>
            OrgRunner.pause(deps.projectDir, deps.org, runID, {
              kind: "final_gate",
              stage,
              detail,
            })
          const paused = await (deps.lock ? deps.lock(pause) : pause())
          await emit(deps, runID, { type: "final_gate", stage, detail })
          return { type: "paused", ...paused.pausedReason! }
        }
        const record = run.stages[stage]
        const path = OrgArtifacts.deliverablePath(deps.projectDir, runID, stage)
        const deliverable = deps.readDeliverable
          ? await deps.readDeliverable({ runID, stage, path })
          : await Bun.file(path)
              .text()
              .catch(() => "")
        const prompt = OrgEvaluator.prompt({
          stage,
          objective: record.objective ?? `Complete stage ${stage}`,
          criteria: record.criteria ?? [],
          deliverable,
        })
        const reply = await deps.evaluate({ runID, stage, model: loop.evaluatorModel, prompt }).catch(() => "")
        const verdict = OrgEvaluator.parse(reply)
        await emit(deps, runID, {
          type: "evaluator_verdict",
          stage,
          pass: verdict.pass,
          detail: verdict.reasons?.join("; ") ?? verdict.summary,
        })
        const apply = () => OrgRunner.applyVerdict(deps.projectDir, deps.org, runID, stage, verdict, deps.now())
        const applied = await (deps.lock ? deps.lock(apply) : apply())
        if (applied.outcome === "escalated" || applied.outcome === "final_gate") {
          const reason = applied.run.pausedReason!
          await emit(deps, runID, {
            type: applied.outcome === "escalated" ? "escalation" : "final_gate",
            stage,
            detail: reason.detail,
          })
          return { type: "paused", ...reason }
        }
        if (applied.outcome === "revise") {
          await emit(deps, runID, {
            type: "revise_iteration",
            stage,
            iteration: applied.run.stages[stage].iterations,
            detail: verdict.reasons?.join("; "),
          })
        }
        continue
      }

      const jobs = [
        ...batch.instruct.map((item) => ({
          stage: item.stage,
          chief: item.chief,
          taskPrompt: item.taskPrompt,
          resumeTaskID: item.resumeTaskID,
        })),
        ...(batch.incomplete
          ? [
              {
                stage: batch.incomplete.stage,
                chief: batch.incomplete.chief ?? deps.org.departments[batch.incomplete.stage].chief,
                taskPrompt: batch.incomplete.taskPrompt ?? batch.incomplete.reason,
                resumeTaskID: batch.incomplete.resumeTaskID,
              },
            ]
          : []),
      ]
      if (jobs.length === 0) {
        const run = await OrgState.read(deps.projectDir, runID)
        const stage = OrgState.runSummary(run).currentStage ?? "none"
        return escalate(stage, "autonomous conductor made no progress")
      }

      const run = await OrgState.read(deps.projectDir, runID)
      for (const job of jobs) await emit(deps, runID, { type: "stage_started", stage: job.stage })
      const settled = await Promise.all(
        jobs.map(async (job) => {
          try {
            return {
              stage: job.stage,
              result: await deps.spawnChief({
                runID,
                stage: job.stage,
                chief: job.chief,
                instruction: instruction(job.taskPrompt, run.stages[job.stage]),
                resumeTaskID: job.resumeTaskID,
              }),
            }
          } catch (error) {
            return { stage: job.stage, error }
          }
        }),
      )
      const failed = settled.find((item): item is { stage: string; error: unknown } => "error" in item)
      if (failed) {
        const message = failed.error instanceof Error ? failed.error.message : String(failed.error)
        return escalate(failed.stage, `chief session failed: ${message}`)
      }
      for (const item of settled) {
        if (!item.result) continue
        const record = () =>
          OrgRunner.recordToolUsage(
            deps.projectDir,
            deps.org,
            runID,
            item.stage,
            item.result.toolIDs ?? [],
          )
        await (deps.lock ? deps.lock(record) : record())
        taskResults.push({ stage: item.stage, taskID: item.result.taskID })
        await emit(deps, runID, {
          type: "deliverable_settled",
          stage: item.stage,
          taskID: item.result.taskID,
          cost: item.result.cost,
        })
      }
    }
  }
}
