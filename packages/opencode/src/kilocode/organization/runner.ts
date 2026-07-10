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
    /** Current time in epoch ms. Injected for deterministic timeout tests; defaults to Date.now. */
    now?: () => number
  }

  /** One stage to run NOW: the CEO spawns these as parallel task-tool calls in a single turn. */
  export type InstructItem = {
    stage: string
    chief: string
    taskPrompt: string
    /** Present when the same chief session should be resumed (revise / retry). */
    resumeTaskID?: string
  }

  export type GateItem = {
    stage: string
    deliverablePath: string
    /** Present when this gate was forced open by the once-per-run cost-escalation check
     * rather than the stage's own pipeline `gate: "human"` declaration. */
    note?: string
  }

  export type IncompleteItem = {
    stage: string
    reason: string
    resumeTaskID?: string
    /** The chief department for this stage; lets the CEO spawn a fresh session when resumeTaskID is unresumable. */
    chief?: string
    /** Full stage prompt (same instruct-path builder, no reviseNote), for briefing a fresh chief session when unresumable. */
    taskPrompt?: string
  }

  /**
   * The result of one `advance` call. With `maxConcurrency: 1` (the default) `instruct` holds at
   * most one item and at most one blocker is set, so a linear org drives byte-identically to the
   * pre-wave single-action runner. With higher concurrency, `instruct` may hold several stages the
   * CEO spawns in parallel, alongside at most ONE serialized blocker (gate/incomplete/halted) —
   * decision #6: gates/incompletes serialize, independent ready stages still fan out.
   */
  export type Batch = {
    /** Stages to run NOW, in parallel (0..maxConcurrency). */
    instruct: InstructItem[]
    /** A single human gate to resolve via org_decision (first blocker in pipeline order). */
    gate?: GateItem
    /** A single incomplete stage the CEO must re-run (first blocker in pipeline order). */
    incomplete?: IncompleteItem
    /** The run halted this call (a hard stop; no further fan-out). */
    halted?: { reason: string }
    /** The run is complete: nothing running, ready, gated, or pending. */
    done?: true
  }

  /**
   * Result of settling ONE running stage that carries a taskID (extracted verbatim from the
   * pre-wave per-stage completion block). "completed" = the stage transitioned (to completed or
   * awaiting_approval) with no blocker to surface; the kinded variants each map to exactly one
   * batch field. "instruct" is a revise re-instruct: the stage restarts as an instruct item.
   */
  type SettleResult =
    | { run: OrgState.Run; result: "completed" }
    | { run: OrgState.Run; result: { kind: "instruct"; item: InstructItem } }
    | { run: OrgState.Run; result: { kind: "gate"; item: GateItem } }
    | { run: OrgState.Run; result: { kind: "incomplete"; item: IncompleteItem } }
    | { run: OrgState.Run; result: { kind: "halted"; reason: string } }

  export function start(projectDir: string, org: OrgSchema.Organization, idea: string, mode?: string) {
    return OrgState.create(projectDir, org, idea, mode)
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

  /**
   * The completed deliverables the target stage should read: its transitive `requires` closure
   * (DAG-aware), completed-only, in deterministic pipeline order. Replaces the pre-wave
   * pipeline-array-prefix walk. Back-compat: for a linear pipeline, each stage's resolved requires
   * is `[prevStage]`, whose transitive closure is exactly the set of all earlier stages — so the
   * closure equals the old array-prefix and linear behavior is byte-identical. A stage still under
   * revision (not yet completed) is excluded, matching the pre-wave "completed only" filter.
   */
  function priorDeliverables(projectDir: string, org: OrgSchema.Organization, run: OrgState.Run, upto: string) {
    const requiresGraph = OrgSchema.resolveRequires(org)
    const closure = new Set<string>()
    const visit = (stage: string) => {
      for (const dep of requiresGraph[stage] ?? []) {
        if (closure.has(dep)) continue
        closure.add(dep)
        visit(dep)
      }
    }
    visit(upto)
    const priors: Array<{ stage: string; path: string }> = []
    // Iterate in pipeline order for deterministic output (mirrors the pre-wave prefix ordering).
    for (const { stage } of org.pipeline) {
      if (!closure.has(stage)) continue
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
  ): InstructItem {
    return {
      stage,
      chief: org.departments[stage].chief,
      resumeTaskID: opts.resumeTaskID,
      taskPrompt: stagePromptFor(projectDir, org, run, stage, opts.reviseNote),
    }
  }

  /**
   * Bounded auto-retry: called at each point `advance` is about to return "incomplete" for a
   * stage whose chief task actually ran this call (record.taskID present — a bare re-instruct
   * with no taskID never reaches here). Increments the stage's incompleteAttempts and, once that
   * exceeds the resolved budget.retries, marks the stage "failed" and halts the run immediately
   * (the W0.4 failed-short-circuit at the top of `advance` then defensively catches it on any
   * later call too). Returns the Advance to hand back to the caller: either the original
   * "incomplete" (a retry remains) or a "halted" (retries exhausted).
   *
   * incompleteAttempts is reset to 0 on two transitions so a fresh phase gets a fresh retry
   * budget: (a) when a revise iteration begins (in `decide`), and (b) on successful stage
   * completion (in `advance`). Without the reset, a transient first-pass incomplete would carry
   * into a later revise loop and fail it early with a misleading reason. The `cause` param keeps
   * the two paths' failure messages honest — never-produced vs. revise-churn.
   *
   * Cost-during-retry: a failing stage's chief session never reaches the completion cost-recording
   * path (that only runs once validation.ok), so retries could otherwise accrue untracked spend.
   * When a taskID is present we cheaply record its cost into the same per-session `costs` map used
   * on completion, so a money-burning retry loop can still trip the run budget ceiling even though
   * it never completes. This does NOT re-run the stage-cap or escalation checks (those stay
   * completion-only by design) — only the run's hard ceiling, since that's the one a runaway loop
   * can quietly blow through.
   *
   * `cause: "timeout"` (W4.5) is a variant of "never-produced" — the deliverable is still invalid,
   * but the stage also blew past its declared `timeoutMs` — worded distinctly so the failure reason
   * points at a chronically-slow-and-empty stage rather than a generic incomplete. `timeoutMs` is
   * only required (and only used for the message) when cause is "timeout".
   */
  async function retryOrFail(
    deps: Deps,
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    run: OrgState.Run,
    stage: string,
    /** Names the true cause so the failure message doesn't mislead: a stage that never produced
     * a deliverable, one that blew past its timeout while still invalid, vs. a revise loop where
     * the chief keeps re-emitting the same file. */
    cause: "never-produced" | "timeout" | "revise-unchanged",
    incomplete: IncompleteItem,
    timeoutMs?: number,
  ): Promise<{ run: OrgState.Run; result: { kind: "incomplete"; item: IncompleteItem } | { kind: "halted"; reason: string } }> {
    const record = run.stages[stage]
    if (!record.taskID) return { run, result: { kind: "incomplete", item: incomplete } } // bare re-instruct with no chief run: not a retry attempt

    const cost = await deps.costOf(record.taskID)
    const budget = OrgSchema.resolveBudget(org)
    let budgetHalted: { reason: string } | undefined
    let failed = false
    run = await OrgState.update(projectDir, runID, (s) => {
      const rec = s.stages[stage]
      rec.incompleteAttempts = (rec.incompleteAttempts ?? 0) + 1

      if (cost !== undefined) {
        const seeded =
          rec.costs ?? (rec.cost !== undefined && rec.costTaskID !== undefined ? { [rec.costTaskID]: rec.cost } : {})
        rec.costs = { ...seeded, [record.taskID!]: cost }
        rec.cost = undefined
        rec.costTaskID = undefined
      }

      const runTotal = Object.values(s.stages).reduce((sum, st) => sum + stageCost(st), 0)
      if (runTotal > budget.run) {
        const reason = `budget ceiling exceeded: run $${runTotal} / cap $${budget.run}`
        s.status = "halted"
        s.haltReason = reason
        budgetHalted = { reason }
        return
      }

      if (rec.incompleteAttempts > budget.retries) {
        const reason =
          cause === "never-produced"
            ? `stage "${stage}" failed after ${rec.incompleteAttempts} incomplete chief runs (deliverable never produced)`
            : cause === "timeout"
              ? `stage "${stage}" failed after ${rec.incompleteAttempts} attempts (exceeded its ${timeoutMs}ms timeout without a valid deliverable)`
              : `stage "${stage}" failed after ${rec.incompleteAttempts} unchanged revise attempts (chief produced the same deliverable)`
        rec.status = "failed"
        s.status = "halted"
        s.haltReason = reason
        failed = true
      }
    })

    if (budgetHalted) {
      await OrgAudit.append(projectDir, runID, {
        ts: new Date().toISOString(),
        stage,
        decision: "stop",
        note: budgetHalted.reason,
      })
      return { run, result: { kind: "halted", reason: budgetHalted.reason } }
    }

    if (failed) {
      const reason = run.haltReason!
      await OrgAudit.append(projectDir, runID, { ts: new Date().toISOString(), stage, decision: "stop", note: reason })
      return { run, result: { kind: "halted", reason } }
    }

    return { run, result: { kind: "incomplete", item: incomplete } }
  }

  /**
   * Evaluates a stage's `when` condition (decision #4, W4.4) against the current run. Pure - no
   * I/O. Absent `when` is always satisfied (today's unconditional behavior). `{mode}` compares
   * against the run-level mode set at org_start; `{stage, decision}` compares against that
   * stage's recorded decision — an UNDEFINED decision (stage never gated / not yet decided, or
   * completed without ever recording one) is NOT a match, so the condition evaluates false rather
   * than throwing or vacuously passing.
   */
  function whenSatisfied(run: OrgState.Run, stage: OrgSchema.Organization["pipeline"][number]): boolean {
    const when = stage.when
    if (!when) return true
    if ("mode" in when) return run.mode === when.mode
    return run.stages[when.stage]?.decision === when.decision
  }

  /**
   * Build a GateItem for `stage`, reading its escalation note (if any) from the persisted
   * `escalationNote` field rather than carrying it only transiently. This is the single site every
   * gate blocker is constructed from (both the settle-loop escalate/human gates and the
   * awaiting-fold's plain-gate fallback), so a note-carrying escalation stage surfaces its note
   * whenever ITS gate is the selected blocker — even on a LATER `advance` call, after an
   * earlier-in-pipeline stage's plain gate was the blocker on the call the escalation actually fired.
   */
  function gateItemFor(run: OrgState.Run, projectDir: string, runID: string, stage: string): GateItem {
    return {
      stage,
      deliverablePath: OrgArtifacts.deliverablePath(projectDir, runID, stage),
      note: run.stages[stage].escalationNote,
    }
  }

  /**
   * Settle ONE running stage that carries a taskID this call — the pre-wave per-stage completion
   * block, extracted VERBATIM so its every invariant (revise re-instruct, validate → retryOrFail
   * never-produced, revise-staleness → retryOrFail revise-unchanged, and the atomic
   * cost+ceiling+escalation `OrgState.update`) is preserved bit-for-bit. `pipelineStage` is the
   * stage's `org.pipeline` entry (carries `gate` and per-stage `budget`), passed in rather than
   * re-found so a fan-out batch settles the correct stage. Returns a normalized SettleResult the
   * batch loop folds into `Batch` fields; a revise re-instruct comes back as an `instruct` item.
   */
  async function settleRunningStage(
    deps: Deps,
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    run: OrgState.Run,
    pipelineStage: OrgSchema.Organization["pipeline"][number],
  ): Promise<SettleResult> {
    const stage = pipelineStage.stage
    const record = run.stages[stage]
    // A revise decision pending on a running stage means: re-instruct the chief.
    if (record.decision === "revise") {
      const note = record.decisionNote
      const resume = record.taskID
      run = await OrgState.update(projectDir, runID, (s) => {
        s.stages[stage].decision = undefined
        s.stages[stage].decisionNote = undefined
        // Persisted past this clear so a later unresumable fresh session can still be briefed
        // with what the user asked to change; cleared together with reviseBaseline on completion.
        s.stages[stage].reviseNote = note
        s.stages[stage].attempts += 1
      })
      return {
        run,
        result: { kind: "instruct", item: instruct(projectDir, org, run, stage, { reviseNote: note, resumeTaskID: resume }) },
      }
    }
    const validation = await OrgArtifacts.validate(projectDir, runID, stage)
    if (!validation.ok) {
      // W4.5: a stage whose deliverable is STILL invalid after blowing past its declared
      // timeoutMs gets a clearer "timeout" failure reason instead of the generic
      // "never-produced" — same retry mechanics/budget, only the cause + message differ. Only
      // reachable here (validation-FAILED branch), so a stage that produced a valid deliverable
      // is never timed out regardless of how long it took.
      const started = record.startedAt ? Date.parse(record.startedAt) : undefined
      const now = (deps.now ?? Date.now)()
      const timedOut =
        pipelineStage.timeoutMs !== undefined && started !== undefined && now - started > pipelineStage.timeoutMs
      const incomplete: IncompleteItem = {
        stage,
        reason: validation.reason,
        resumeTaskID: record.taskID,
        chief: org.departments[stage].chief,
        taskPrompt: stagePromptFor(projectDir, org, run, stage, record.reviseNote),
      }
      // Shares incompleteAttempts with the revise-unchanged site below, but means something
      // different: here the deliverable was never produced (first-pass chief stall) — or, when
      // timedOut, never produced AND the stage's timeoutMs elapsed.
      return timedOut
        ? retryOrFail(deps, projectDir, org, runID, run, stage, "timeout", incomplete, pipelineStage.timeoutMs)
        : retryOrFail(deps, projectDir, org, runID, run, stage, "never-produced", incomplete)
    }
    // Revise-staleness guard: the pre-revise deliverable is still valid on disk; it must actually change.
    if (record.reviseBaseline && (await deliverableHash(projectDir, runID, stage)) === record.reviseBaseline) {
      // Shares incompleteAttempts with the never-produced site above, but means something
      // different: here the deliverable exists and is valid, the chief just re-emitted the same
      // content in a revise loop. incompleteAttempts was reset when this revise iteration began
      // (in decide), so revise churn gets its own fresh retry budget.
      return retryOrFail(deps, projectDir, org, runID, run, stage, "revise-unchanged", {
        stage,
        reason: `deliverable unchanged since revise was requested (${OrgArtifacts.deliverablePath(projectDir, runID, stage)})`,
        resumeTaskID: record.taskID,
        chief: org.departments[stage].chief,
        taskPrompt: stagePromptFor(projectDir, org, run, stage, record.reviseNote),
      })
    }
    const cost = record.taskID ? await deps.costOf(record.taskID) : undefined
    const budget = OrgSchema.resolveBudget(org)
    const stageCap = pipelineStage.budget ?? budget.stage
    // Populated inside the update callback (which has the freshest post-cost state) and acted
    // on afterward, so the halt / escalation decision and its state mutation land atomically
    // in the same OrgState.update as the cost recording.
    let budgetOutcome: { kind: "halted"; reason: string } | { kind: "escalate"; runTotal: number } | undefined
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
      rec.incompleteAttempts = 0 // stage completed: any later revise loop starts with a fresh retry budget
      rec.status = pipelineStage.gate === "human" ? "awaiting_approval" : "completed"

      // Budget checks run after cost is recorded but before the gate/completed/next decision
      // downstream reacts to. Hard ceiling takes precedence over the soft escalation gate.
      // Ceiling is enforced POST-stage: a stage that overshoots completes and records its cost
      // before this halt fires; mid-stage spend is not observable to the runner.
      const runTotal = Object.values(s.stages).reduce((sum, st) => sum + stageCost(st), 0)
      const stageTotal = stageCost(rec)
      if (runTotal > budget.run) {
        const reason = `budget ceiling exceeded: run $${runTotal} / cap $${budget.run}`
        s.status = "halted"
        s.haltReason = reason
        budgetOutcome = { kind: "halted", reason }
      } else if (stageTotal > stageCap) {
        const reason = `budget ceiling exceeded: stage "${stage}" $${stageTotal} / cap $${stageCap}`
        s.status = "halted"
        s.haltReason = reason
        budgetOutcome = { kind: "halted", reason }
      } else if (runTotal >= budget.escalationThreshold && !s.escalated) {
        s.escalated = true
        if (pipelineStage.gate !== "human") {
          rec.status = "awaiting_approval"
          rec.escalationNote = `cost $${runTotal} reached the $${budget.escalationThreshold} escalation threshold — review before continuing`
          budgetOutcome = { kind: "escalate", runTotal }
        }
      }
    })

    if (budgetOutcome?.kind === "halted") {
      await OrgAudit.append(projectDir, runID, {
        ts: new Date().toISOString(),
        stage,
        decision: "stop",
        note: budgetOutcome.reason,
      })
      return { run, result: { kind: "halted", reason: budgetOutcome.reason } }
    }
    if (budgetOutcome?.kind === "escalate") {
      return { run, result: { kind: "gate", item: gateItemFor(run, projectDir, runID, stage) } }
    }
    if (pipelineStage.gate === "human") {
      return { run, result: { kind: "gate", item: gateItemFor(run, projectDir, runID, stage) } }
    }
    return { run, result: "completed" }
  }

  export async function advance(
    deps: Deps,
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    input: { taskID?: string },
  ): Promise<Batch> {
    let run = await OrgState.read(projectDir, runID)
    assertPipelineMatches(org, run)
    if (run.status === "halted") return { instruct: [], halted: { reason: run.haltReason ?? "run halted" } }
    if (run.status === "completed") return { instruct: [], done: true }

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
        instruct: [],
        halted: {
          reason: `stage "${failed.stage}" failed${record.decisionNote ? ": " + record.decisionNote : ""}; resolve it before continuing`,
        },
      }
    }

    // Record input.taskID onto the stage the CEO just finished. Resolution order (deterministic,
    // pipeline order):
    //   1. the first running stage that currently LACKS a taskID (fresh fan-out branch);
    //   2. else, if exactly ONE stage is running, that stage — this OVERWRITES its prior taskID,
    //      which is exactly the pre-wave single-active-stage behavior (a revise/retry resume reports
    //      a new-or-same session id over the running stage's existing one; byte-identical to the old
    //      unconditional `s.stages[stage].taskID = input.taskID`);
    //   3. else fall back to a taskID reported LATE for a stage already gated (the pre-wave "taskID
    //      reported at a gate is persisted" behavior) — first awaiting stage lacking one.
    // With maxConcurrency:1 there is at most one running stage, so rule 1-or-2 collapses to the
    // pre-wave "assign to the running stage" exactly. W4.6 widens the input to per-branch task_ids.
    if (input.taskID) {
      const running = OrgState.runningStages(org, run)
      const target =
        running.find((stage) => !run.stages[stage].taskID) ??
        (running.length === 1 ? running[0] : undefined) ??
        OrgState.awaitingStages(org, run).find((stage) => !run.stages[stage].taskID)
      if (target) {
        run = await OrgState.update(projectDir, runID, (s) => {
          s.stages[target].taskID = input.taskID
        })
      }
    }

    // Settle every running stage, in pipeline order (mirrors the pre-wave runner, which settled the
    // single running stage regardless of whether a taskID was present this call — a pending revise
    // re-instructs, a missing deliverable returns incomplete without burning a retry when there's no
    // taskID, a valid deliverable completes/gates). The FIRST stage whose settle yields a blocker
    // (gate/incomplete/halted) is surfaced as the batch's single blocker (decision #6); a revise
    // re-instruct is collected as an instruct item. Completed stages just transition. Once a settle
    // halts the run, stop — no further settles, no fan-out.
    const batch: Batch = { instruct: [] }
    let blocker: { kind: "gate"; item: GateItem } | { kind: "incomplete"; item: IncompleteItem } | undefined
    const byPipelineIndex = (a: string, b: string) =>
      org.pipeline.findIndex((p) => p.stage === a) - org.pipeline.findIndex((p) => p.stage === b)
    // Snapshot the settle set up front (pipeline order), so mutations during the loop don't shift it.
    const toSettle = OrgState.runningStages(org, run)
    for (const stage of toSettle) {
      const pipelineStage = org.pipeline.find((p) => p.stage === stage)!
      const settled = await settleRunningStage(deps, projectDir, org, runID, run, pipelineStage)
      run = settled.run
      const r = settled.result
      if (r === "completed") continue
      if (r.kind === "halted") {
        // A hard halt is terminal: surface it immediately, skip remaining settles and fan-out.
        return { instruct: batch.instruct, halted: { reason: r.reason } }
      }
      if (r.kind === "instruct") {
        // A revise re-instruct restarts this stage; it fans out alongside independent work.
        batch.instruct.push(r.item)
        continue
      }
      // gate / incomplete: keep the FIRST in pipeline order as the single serialized blocker.
      if (!blocker || byPipelineIndex(r.item.stage, blocker.item.stage) < 0) blocker = r
    }

    // A stage sitting in awaiting_approval (gated on a PRIOR call, still un-decided) blocks like a
    // fresh gate until org_decision. Fold the first such stage (pipeline order) into the blocker
    // slot if no earlier settle-produced blocker already claimed it — this preserves the pre-wave
    // "repeated advance while awaiting keeps returning the gate" idempotency and the late-taskID
    // gate persistence. gateItemFor reads the persisted escalationNote, so a stage that escalated on
    // an earlier call (when a different, earlier-in-pipeline stage's plain gate won the blocker slot)
    // still surfaces its note once ITS gate is finally selected here.
    for (const stage of OrgState.awaitingStages(org, run)) {
      // Skip a stage that this call's settle already surfaced (e.g. its escalation gate, which
      // carries the note); only PRE-EXISTING awaiting stages need this fallback.
      if (blocker?.item.stage === stage) continue
      const item = gateItemFor(run, projectDir, runID, stage)
      if (!blocker || byPipelineIndex(stage, blocker.item.stage) < 0) blocker = { kind: "gate", item }
    }

    // Fan out ready stages into the remaining concurrency slots. Independent ready stages still
    // start alongside a serialized blocker (decision #6). runningStages is re-derived from the
    // freshly-settled `run`, so stages that just completed no longer occupy slots.
    //
    // W4.4: before a ready stage is marked "running", its `when` (if present) is evaluated. A
    // false `when` marks the stage "skipped" instead — status only, no startedAt/attempts/cost,
    // no instruct — and readyStages is RE-COMPUTED afterward, since a skipped stage satisfies its
    // dependents (OrgState.isSatisfied treats "skipped" like "completed"), so a stage gated only
    // on the just-skipped one may become ready within the SAME call. Skipped stages never consume
    // a concurrency slot, so this loop keeps filling slots until nothing more is ready or slots
    // run out.
    const maxConcurrency = org.maxConcurrency ?? 1
    for (;;) {
      const runningCount = OrgState.runningStages(org, run).length
      const slots = Math.max(0, maxConcurrency - runningCount)
      if (slots === 0) break
      const ready = OrgState.readyStages(org, run).slice(0, slots)
      if (ready.length === 0) break

      const toRun: string[] = []
      const toSkip: string[] = []
      for (const stage of ready) {
        const pipelineStage = org.pipeline.find((p) => p.stage === stage)!
        if (whenSatisfied(run, pipelineStage)) toRun.push(stage)
        else toSkip.push(stage)
      }

      if (toSkip.length > 0) {
        run = await OrgState.update(projectDir, runID, (s) => {
          for (const stage of toSkip) s.stages[stage].status = "skipped"
        })
      }
      if (toRun.length > 0) {
        run = await OrgState.update(projectDir, runID, (s) => {
          for (const stage of toRun) {
            s.stages[stage].status = "running"
            s.stages[stage].startedAt = new Date().toISOString()
            s.stages[stage].attempts += 1
          }
        })
        for (const stage of toRun) batch.instruct.push(instruct(projectDir, org, run, stage))
      }

      // Only a skip can change readiness (a skipped stage satisfies its dependents, same as
      // completed). If this pass skipped nothing, another pass would just re-derive the same
      // state, so stop; otherwise loop to pick up any newly-ready dependents with the slots the
      // skip(s) freed.
      if (toSkip.length === 0) break
    }

    // Attach the single serialized blocker (if any).
    if (blocker?.kind === "gate") batch.gate = blocker.item
    else if (blocker?.kind === "incomplete") batch.incomplete = blocker.item

    // The run is complete only when nothing is running, awaiting, or pending, and nothing was
    // instructed or gated this call. A lingering pending/blocked stage (requires unmet with nothing
    // upstream to satisfy it) is NOT completion — it keeps the run active rather than silently
    // finishing with work stranded (a valid acyclic DAG can't strand a stage whose ancestors all
    // completed, but this guard makes the terminal condition explicit and defensive).
    const noPendingLeft = OrgState.readyStages(org, run).length === 0 && OrgState.blockedStages(org, run).length === 0
    if (
      batch.instruct.length === 0 &&
      !batch.gate &&
      !batch.incomplete &&
      OrgState.runningStages(org, run).length === 0 &&
      OrgState.awaitingStages(org, run).length === 0 &&
      noPendingLeft
    ) {
      await OrgState.update(projectDir, runID, (s) => {
        s.status = "completed"
      })
      return { instruct: [], done: true }
    }

    return batch
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
      // A resolved gate never carries a stale note into a later re-gate of this stage (e.g. a
      // subsequent revise -> re-completion -> new gate, or another escalation crossing).
      record.escalationNote = undefined
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
        record.incompleteAttempts = 0 // fresh revise iteration: revise churn gets its own retry budget, not the pre-completion count
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
   * and appends an audit entry. Returns the running stage (if any) and its taskID so the caller
   * can cancel the live chief session and word its report precisely. org_advance already
   * short-circuits on status "halted", so this alone is sufficient to stop the pipeline from
   * progressing further.
   */
  export async function stop(
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    reason: string,
  ): Promise<{ run: OrgState.Run; stage?: string; taskID?: string }> {
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
    return { run: updated, stage, taskID }
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
