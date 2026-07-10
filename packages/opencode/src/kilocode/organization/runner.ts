// kilocode_change - new file
import { createHash } from "node:crypto"
import { OrgSchema } from "./schema"
import { OrgState } from "./state"
import { OrgArtifacts } from "./artifacts"
import { OrgPrompts } from "./prompts"
import { OrgAudit } from "./audit"

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
    | {
        kind: "incomplete"
        stage: string
        reason: string
        resumeTaskID?: string
        /** The chief department for this stage; lets the CEO spawn a fresh session when resumeTaskID is unresumable. */
        chief?: string
        /** Full stage prompt (same instruct-path builder, no reviseNote), for briefing a fresh chief session when unresumable. */
        taskPrompt?: string
      }
    | { kind: "halted"; reason: string }
    | { kind: "done" }

  export function start(projectDir: string, org: OrgSchema.Organization, idea: string) {
    return OrgState.create(projectDir, org, idea)
  }

  /**
   * Total cost of a stage: sum of per-session cumulative costs, falling back to the legacy
   * single-slot `cost` field when `costs` is absent/empty (state.json written before per-session
   * tracking existed).
   */
  function stageCost(stage: OrgState.Stage): number {
    const values = Object.values(stage.costs ?? {})
    if (values.length > 0) return values.reduce((sum, c) => sum + c, 0)
    return stage.cost ?? 0
  }

  /** Hash of the stage deliverable as currently on disk (empty string when unreadable). */
  async function deliverableHash(projectDir: string, runID: string, stage: string): Promise<string> {
    const text = await Bun.file(OrgArtifacts.deliverablePath(projectDir, runID, stage))
      .text()
      .catch(() => "")
    return createHash("sha256").update(text).digest("hex")
  }

  /** Same hash as `deliverableHash`, but undefined (not the hash of "") when the deliverable is
   * unreadable — used for the audit trail, where a read failure must be omitted rather than
   * recorded as a real hash value. */
  async function deliverableHashOrUndefined(
    projectDir: string,
    runID: string,
    stage: string,
  ): Promise<string | undefined> {
    const text = await Bun.file(OrgArtifacts.deliverablePath(projectDir, runID, stage))
      .text()
      .catch(() => undefined)
    if (text === undefined) return undefined
    return createHash("sha256").update(text).digest("hex")
  }

  /**
   * Guard against organization.jsonc changing mid-run: the run's stage set and the org's
   * pipeline stage set must match exactly, in both directions.
   */
  function assertPipelineMatches(org: OrgSchema.Organization, run: OrgState.Run): void {
    for (const { stage } of org.pipeline) {
      if (!run.stages[stage]) {
        throw new Error(
          `run ${run.runID} was created with a different pipeline (stage "${stage}" missing); organization.jsonc changed mid-run?`,
        )
      }
    }
    const pipelineStages = new Set(org.pipeline.map(({ stage }) => stage))
    for (const stage of Object.keys(run.stages)) {
      if (!pipelineStages.has(stage)) {
        throw new Error(
          `run ${run.runID} was created with a different pipeline (stage "${stage}" no longer in organization.jsonc); organization.jsonc changed mid-run?`,
        )
      }
    }
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

  /**
   * The single stage-prompt builder: `instruct` delegates here, and the `incomplete` path uses
   * it (with the stage's persisted reviseNote) to brief a fresh chief session when the
   * resumeTaskID turns out unresumable.
   */
  function stagePromptFor(
    projectDir: string,
    org: OrgSchema.Organization,
    run: OrgState.Run,
    stage: string,
    reviseNote?: string,
  ): string {
    const dept = org.departments[stage]
    return OrgPrompts.stagePrompt({
      stage,
      idea: run.idea,
      deliverablePath: OrgArtifacts.deliverablePath(projectDir, run.runID, stage),
      workers: dept.workers,
      shared: org.shared,
      priorDeliverables: priorDeliverables(projectDir, org, run, stage),
      reviseNote,
    })
  }

  function instruct(
    projectDir: string,
    org: OrgSchema.Organization,
    run: OrgState.Run,
    stage: string,
    opts: { reviseNote?: string; resumeTaskID?: string } = {},
  ): Advance {
    return {
      kind: "instruct",
      stage,
      chief: org.departments[stage].chief,
      resumeTaskID: opts.resumeTaskID,
      taskPrompt: stagePromptFor(projectDir, org, run, stage, opts.reviseNote),
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
    assertPipelineMatches(org, run)
    if (run.status === "halted") return { kind: "halted", reason: run.haltReason ?? "run halted" }
    if (run.status === "completed") return { kind: "done" }

    // A failed stage blocks the pipeline (run stays active so future recovery can resume it).
    const failed = org.pipeline.find(({ stage }) => run.stages[stage].status === "failed")
    if (failed) {
      if (input.taskID) {
        run = await OrgState.update(projectDir, runID, (s) => {
          s.stages[failed.stage].taskID = input.taskID
        })
      }
      const record = run.stages[failed.stage]
      return {
        kind: "halted",
        reason: `stage "${failed.stage}" failed${record.decisionNote ? ": " + record.decisionNote : ""}; resolve it before continuing`,
      }
    }

    // 1. A stage awaiting approval blocks everything until org_decision.
    const awaiting = org.pipeline.find(({ stage }) => run.stages[stage].status === "awaiting_approval")
    if (awaiting) {
      if (input.taskID) {
        await OrgState.update(projectDir, runID, (s) => {
          s.stages[awaiting.stage].taskID = input.taskID
        })
      }
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
          // Persisted past this clear so a later unresumable fresh session can still be briefed
          // with what the user asked to change; cleared together with reviseBaseline on completion.
          s.stages[stage].reviseNote = note
          s.stages[stage].attempts += 1
        })
        return instruct(projectDir, org, run, stage, { reviseNote: note, resumeTaskID: resume })
      }
      const validation = await OrgArtifacts.validate(projectDir, runID, stage)
      if (!validation.ok) {
        return {
          kind: "incomplete",
          stage,
          reason: validation.reason,
          resumeTaskID: record.taskID,
          chief: org.departments[stage].chief,
          taskPrompt: stagePromptFor(projectDir, org, run, stage, record.reviseNote),
        }
      }
      // Revise-staleness guard: the pre-revise deliverable is still valid on disk; it must actually change.
      if (record.reviseBaseline && (await deliverableHash(projectDir, runID, stage)) === record.reviseBaseline) {
        return {
          kind: "incomplete",
          stage,
          reason: `deliverable unchanged since revise was requested (${OrgArtifacts.deliverablePath(projectDir, runID, stage)})`,
          resumeTaskID: record.taskID,
          chief: org.departments[stage].chief,
          taskPrompt: stagePromptFor(projectDir, org, run, stage, record.reviseNote),
        }
      }
      const cost = record.taskID ? await deps.costOf(record.taskID) : undefined
      run = await OrgState.update(projectDir, runID, (s) => {
        const rec = s.stages[stage]
        rec.completedAt = new Date().toISOString()
        if (cost !== undefined && record.taskID) {
          // Per-session key: a resumed session reports cumulative cost, so this is a pure
          // overwrite of its own entry; a distinct session occupies a distinct key, so totals
          // accumulate naturally with no double-counting across A-B-A style alternation.
          // First completion after upgrade migrates legacy single-slot cost into the map
          // (a resumed legacy session then overwrites its own seeded key, which is correct),
          // and clears the legacy fields so each state.json is single-sourced.
          const seeded =
            rec.costs ?? (rec.cost !== undefined && rec.costTaskID !== undefined ? { [rec.costTaskID]: rec.cost } : {})
          rec.costs = { ...seeded, [record.taskID]: cost }
          rec.cost = undefined
          rec.costTaskID = undefined
        }
        rec.reviseBaseline = undefined // changed content accepted; baseline consumed
        rec.reviseNote = undefined // lives and dies with the baseline
        rec.status = running.gate === "human" ? "awaiting_approval" : "completed"
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
    assertPipelineMatches(org, run)
    const gated = org.pipeline.find(({ stage }) => run.stages[stage].status === "awaiting_approval")
    if (!gated) throw new Error(`Cannot record decision "${decision}": no stage awaiting approval in run ${runID}`)
    // Snapshot the deliverable a revise starts from, so completion can prove it actually changed.
    const reviseBaseline = decision === "revise" ? await deliverableHash(projectDir, runID, gated.stage) : undefined
    // Same on-disk deliverable, hashed once at decision time for the audit trail.
    const deliverableHashForAudit = await deliverableHashOrUndefined(projectDir, runID, gated.stage)
    const updated = await OrgState.update(projectDir, runID, (s) => {
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
        record.reviseBaseline = reviseBaseline
        record.completedAt = undefined // the pre-revise completion timestamp is stale now
        // the costs map is left as-is: it reflects real spend so far; the session's own key is overwritten on next completion.
      }
    })
    await OrgAudit.append(projectDir, runID, {
      ts: new Date().toISOString(),
      stage: gated.stage,
      decision,
      note,
      deliverableHash: deliverableHashForAudit,
    })
    return updated
  }

  /**
   * Emergency stop: halts the run immediately regardless of current status, records the reason,
   * and appends an audit entry. Returns the running stage's taskID (if any) so the caller can
   * cancel the live chief session. org_advance already short-circuits on status "halted", so this
   * alone is sufficient to stop the pipeline from progressing further.
   */
  export async function stop(
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    reason: string,
  ): Promise<{ run: OrgState.Run; taskID?: string }> {
    const run = await OrgState.read(projectDir, runID)
    assertPipelineMatches(org, run)
    const running = org.pipeline.find(({ stage }) => run.stages[stage].status === "running")
    const stage = running?.stage
    const taskID = stage ? run.stages[stage].taskID : undefined
    const haltReason = `emergency stop: ${reason}`
    const updated = await OrgState.update(projectDir, runID, (s) => {
      s.status = "halted"
      s.haltReason = haltReason
    })
    await OrgAudit.append(projectDir, runID, {
      ts: new Date().toISOString(),
      stage: stage ?? "none",
      decision: "stop",
      note: reason,
    })
    return { run: updated, taskID }
  }

  export async function status(projectDir: string, org: OrgSchema.Organization, runID: string) {
    const run = await OrgState.read(projectDir, runID)
    assertPipelineMatches(org, run)
    const totalCost = Object.values(run.stages).reduce((sum, s) => sum + stageCost(s), 0)
    const approvals = await OrgAudit.read(projectDir, runID)
    return {
      run,
      totalCost,
      pipeline: org.pipeline.map(({ stage, gate }) => ({ stage, gate, ...run.stages[stage] })),
      approvals,
    }
  }
}
