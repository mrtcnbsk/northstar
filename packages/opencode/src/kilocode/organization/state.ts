// kilocode_change - new file
import path from "path"
import { readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import z from "zod"
import { Filesystem } from "../../util/filesystem"
import { OrgSchema } from "./schema"
import { OrgIrreversible } from "./irreversible"
import { OrgWorkspace } from "./workspace"

export namespace OrgState {
  export const StageStatus = z.enum([
    "pending",
    "running",
    "awaiting_approval",
    "completed",
    "skipped",
    "failed",
  ])
  export type StageStatus = z.output<typeof StageStatus>

  export const Stage = z.object({
    status: StageStatus,
    taskID: z.string().optional(),
    /** @deprecated superseded by `costs`; kept optional for reading old state.json files. */
    cost: z.number().optional(),
    /** @deprecated superseded by `costs`; kept optional for reading old state.json files. */
    costTaskID: z.string().optional(),
    /** taskID -> that session's latest cumulative cost. Distinct sessions accumulate; a resumed session overwrites its own key. */
    costs: z.record(z.string(), z.number()).optional(),
    attempts: z.number().default(0),
    /** Count of times this stage returned "incomplete" after a chief task actually ran (distinct
     * from `attempts`, which counts instruct issuances). Drives the bounded auto-retry: once this
     * exceeds the resolved budget.retries, the stage is marked "failed" and the run is halted. */
    incompleteAttempts: z.number().optional(),
    decision: z.enum(["approve", "no-go", "revise"]).optional(),
    decisionNote: z.string().optional(),
    /** Deliverable hash captured when revise was requested; unchanged content cannot re-complete the stage. */
    reviseBaseline: z.string().optional(),
    /** The user's revise note, persisted past the re-instruct (which clears decisionNote) so an unresumable fresh session can still be briefed; lives and dies with reviseBaseline. */
    reviseNote: z.string().optional(),
    /** Set on a revise decision to OrgGraph.impactRadius(org, stage): the downstream stages this
     * revise invalidates. Pure metadata for observability - the runner does NOT auto-reopen or
     * mutate those stages' own status. Optional/back-compat: absent on state.json written before
     * this field existed, and on stages that have never been revised. */
    invalidatedDownstream: z.array(z.string()).optional(),
    /** Set together with the once-per-run cost-escalation gate (see OrgRunner.settleRunningStage);
     * the persisted home for the note transient GateItems used to carry directly. Needed because
     * under maxConcurrency>1 an earlier-in-pipeline stage's plain gate can be the serialized blocker
     * on the call the escalation actually fires, so the note must survive to be re-surfaced once
     * THIS stage's own gate is later selected as the blocker. Cleared when the gated stage is
     * resolved (decide) so a later re-gate never carries a stale note. */
    escalationNote: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    /** Human-approved, per-run snapshot used by the autonomous evaluator. */
    criteria: z.array(z.string().min(1)).optional(),
    /** Human-approved objective supplied by the one-shot plan. */
    objective: z.string().min(1).optional(),
    /** Number of evaluator revise verdicts applied to this stage. */
    iterations: z.number().int().nonnegative().optional(),
    verdictHistory: z
      .array(
        z.object({
          pass: z.boolean(),
          reasons: z.array(z.string().min(1)).optional(),
          summary: z.string().min(1).optional(),
          ts: z.number(),
        }),
      )
      .optional(),
    /** Exact tool IDs observed across chief iterations; used by the irreversible final-gate policy. */
    toolsUsed: z.array(z.string().min(1)).optional(),
  })
  export type Stage = z.output<typeof Stage>

  /**
   * A mid-run side-channel note (Task 7.3, EPIC 7): queued via `org_note`, surfaced read-only into
   * a target agent's NEXT stage instruction by `OrgRunner.stagePromptFor`. `target` is an agent
   * name (chief or worker), `"*"` (broadcast to every stage), or the org's ceo agent name (also
   * treated as a broadcast, since the CEO itself never receives a `stagePromptFor` prompt).
   * `consumedByStage` is set once the note has been surfaced into some stage's prompt, so it is
   * never repeated on a later instruct of the same or another stage.
   */
  export const Note = z.object({
    id: z.string(),
    target: z.string(),
    text: z.string(),
    from: z.string().optional(),
    ts: z.string(),
    consumedByStage: z.string().optional(),
  })
  export type Note = z.output<typeof Note>

  export const Run = z.object({
    runID: z.string(),
    organizationID: z.string().optional(),
    idea: z.string(),
    createdAt: z.string(),
    status: z.enum(["active", "paused", "halted", "completed"]),
    haltReason: z.string().optional(),
    auto: z.boolean().optional(),
    /** Root/CEO session that owns child chief and evaluator sessions for the headless driver. */
    ownerSessionID: z.string().optional(),
    /** Single-use authorization minted by a final-gate approval for the next denylisted action stage. */
    irreversibleApproval: z.object({ stage: z.string(), ts: z.number() }).optional(),
    pausedReason: z
      .object({
        kind: z.enum(["escalation", "final_gate", "manual"]),
        stage: z.string(),
        detail: z.string(),
      })
      .optional(),
    stages: z.record(z.string(), Stage),
    /** Set once the soft cost-escalation gate has fired for this run; prevents it from firing again. */
    escalated: z.boolean().optional(),
    /** Optional run-level mode (e.g. "mvp", "full"), set at org_start and consulted by stage `when: {mode}` conditions. */
    mode: z.string().optional(),
    /** Side-channel notes (Task 7.3). Optional/back-compat: absent on state.json written before
     * this field existed, and on any run nothing has ever been noted on. */
    notes: z.array(Note).optional(),
  })
  export type Run = z.output<typeof Run>

  /**
   * Total cost of a single stage: sum of per-session cumulative costs, falling back to the legacy
   * single-slot `cost` field when `costs` is absent/empty (state.json written before per-session
   * tracking existed). Mirrors the private stageCost in OrgRunner, but is state-only (no org needed).
   */
  export function stageCost(stage: Stage): number {
    const values = Object.values(stage.costs ?? {})
    if (values.length > 0) return values.reduce((sum, c) => sum + c, 0)
    return stage.cost ?? 0
  }

  /**
   * A read-only, org-free summary of a run derived purely from its self-contained state.json.
   * Used by the observability HTTP API so it works even if organization.jsonc has changed or is
   * absent. `stages` iterates in pipeline order because OrgState.create builds the stages record
   * from org.pipeline in order and JS preserves object insertion order.
   */
  export function runSummary(run: Run) {
    const entries = Object.entries(run.stages)
    const totalCost = entries.reduce((sum, [, stage]) => sum + stageCost(stage), 0)
    const awaitingGate = entries.some(([, stage]) => stage.status === "awaiting_approval")
    // First non-terminal stage in pipeline order: the one that is running or awaiting a gate.
    const current = entries.find(([, stage]) => stage.status === "running" || stage.status === "awaiting_approval")
    return {
      totalCost,
      awaitingGate,
      currentStage: current?.[0] ?? null,
      stageCount: entries.length,
    }
  }

  /** A requirement is satisfied for readiness purposes once its stage is completed OR skipped. */
  function isSatisfied(run: Run, stageName: string): boolean {
    const status = run.stages[stageName]?.status
    return status === "completed" || status === "skipped"
  }

  /**
   * Stage names whose status is "pending" and whose every resolved `requires` entry is
   * "completed" or "skipped" (a stage with `requires: []` is ready as soon as it's pending).
   * Pure - no I/O. Iterates in `org.pipeline` order for deterministic output.
   */
  export function readyStages(org: OrgSchema.Organization, run: Run): string[] {
    const requiresGraph = OrgSchema.resolveRequires(org)
    return org.pipeline
      .filter((p) => run.stages[p.stage]?.status === "pending")
      .filter((p) => (requiresGraph[p.stage] ?? []).every((dep) => isSatisfied(run, dep)))
      .map((p) => p.stage)
  }

  /** Stage names currently "running", in pipeline order. Pure - no I/O. */
  export function runningStages(org: OrgSchema.Organization, run: Run): string[] {
    return org.pipeline.filter((p) => run.stages[p.stage]?.status === "running").map((p) => p.stage)
  }

  /** Stage names currently "awaiting_approval", in pipeline order. Pure - no I/O. */
  export function awaitingStages(org: OrgSchema.Organization, run: Run): string[] {
    return org.pipeline.filter((p) => run.stages[p.stage]?.status === "awaiting_approval").map((p) => p.stage)
  }

  /**
   * Stage names that are "pending" but NOT ready - at least one resolved `requires` entry is not
   * yet completed/skipped. Pure - no I/O. Iterates in `org.pipeline` order.
   */
  export function blockedStages(org: OrgSchema.Organization, run: Run): string[] {
    const requiresGraph = OrgSchema.resolveRequires(org)
    return org.pipeline
      .filter((p) => run.stages[p.stage]?.status === "pending")
      .filter((p) => !(requiresGraph[p.stage] ?? []).every((dep) => isSatisfied(run, dep)))
      .map((p) => p.stage)
  }

  /** Whether the authored stage itself requires the final human gate. Tool-use checks are separate. */
  export function isIrreversible(org: OrgSchema.Organization, stage: string): boolean {
    const authored = org.pipeline.find((entry) => entry.stage === stage)
    return authored ? OrgIrreversible.stage(authored) : false
  }

  /** Pure filter used by driver recovery and observability callers. */
  export function pausedRuns(runs: readonly Run[]): Run[] {
    return runs.filter((run) => run.status === "paused")
  }

  export function runsDir(projectDir: string): string {
    return OrgWorkspace.current(projectDir)?.paths.runs ?? path.join(projectDir, ".kilo", "org", "runs")
  }

  export function runDir(projectDir: string, runID: string): string {
    return path.join(runsDir(projectDir), runID)
  }

  function stateFile(projectDir: string, runID: string): string {
    return path.join(runDir(projectDir, runID), "state.json")
  }

  export function slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics (escaped so NFC-normalizing editors can't corrupt the range)
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .slice(0, 40)
        .replace(/-+$/, "") || "run"
    )
  }

  function stamp(date: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0")
    return (
      `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
      `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
    )
  }

  export async function create(
    projectDir: string,
    org: OrgSchema.Organization,
    idea: string,
    mode?: string,
    ownerSessionID?: string,
  ): Promise<Run> {
    const now = new Date()
    const runID = `${stamp(now)}-${slugify(idea)}`
    const run: Run = {
      runID,
      organizationID: OrgWorkspace.current(projectDir)?.entry.id,
      idea,
      createdAt: now.toISOString(),
      status: "active",
      stages: Object.fromEntries(
        org.pipeline.map((s) => [
          s.stage,
          {
            status: "pending" as const,
            attempts: 0,
            ...(s.criteria ? { criteria: [...s.criteria] } : {}),
          },
        ]),
      ),
      mode,
      ownerSessionID,
    }
    await write(projectDir, run)
    return run
  }

  /** True for a runID containing a path separator or `..` segment -- i.e. anything that could escape
   * the runs dir when joined into a path. runIDs are always generated via stamp()+slugify() (see
   * create), so a legitimate runID never contains these; this only ever rejects hostile/malformed input. */
  function isTraversal(runID: string): boolean {
    return runID.includes("/") || runID.includes("\\") || runID.includes("..")
  }

  /**
   * Thrown by `read` when a run genuinely does not exist (traversal-rejected runID, or ENOENT on
   * its state.json). Distinguishes "not found" from "found but corrupt/unreadable" (a plain Error
   * or a Zod/SyntaxError from a malformed/schema-invalid state.json) so callers -- e.g. the
   * org-runs HTTP API -- can map the former to 404 and the latter to a 500 instead of silently
   * masking corruption as absence. Message text is unchanged from before this type existed.
   */
  export class NotFound extends Error {}

  export async function read(projectDir: string, runID: string): Promise<Run> {
    if (isTraversal(runID)) throw new NotFound(`Unknown org run "${runID}": expected ${stateFile(projectDir, runID)}`)
    const file = stateFile(projectDir, runID)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new NotFound(`Unknown org run "${runID}": expected ${file}`)
        }
        throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    return Run.parse(JSON.parse(text))
  }

  /** Read-modify-write without locking: safe because org tools are CEO-only and a single CEO session calls them serially; org_advance is idempotent by runner design. */
  export async function update(projectDir: string, runID: string, fn: (run: Run) => void): Promise<Run> {
    const run = await read(projectDir, runID)
    fn(run)
    await write(projectDir, run)
    return run
  }

  export async function list(projectDir: string): Promise<string[]> {
    const dir = runsDir(projectDir)
    const entries = await readdir(dir, { withFileTypes: true }).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return []
      throw new Error(`Failed to list org runs in ${dir}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  }

  // Filesystem.write is atomic (unique tmp suffix + rename) and mkdirs the parent on ENOENT.
  async function write(projectDir: string, run: Run): Promise<void> {
    await Filesystem.write(stateFile(projectDir, run.runID), JSON.stringify(run, null, 2))
  }
}

/**
 * Task 7.3 (EPIC 7, TUI Chat): the org_note side-channel core. Appending a note is the ONLY
 * mutation this namespace performs (via `OrgState.update`, same read-modify-write primitive every
 * other org mutator uses); it never touches `run.stages`/`run.status`/`run.escalated` or any other
 * field the runner's state machine reads, so appending a note can never perturb a run's
 * deterministic progression (see `OrgRunner.stagePromptFor`'s surfacing + org-note.test.ts's
 * determinism pin). A note is read-only at prompt-build time: `OrgRunner.stagePromptFor` only
 * SURFACES a matching note into a prompt (and returns its id); it performs no write. Consumption
 * (marking `consumedByStage`) happens in exactly one place — `OrgRunner.advance`, once per call, in
 * a single serial update strictly after its fan-out settles, and ONLY for notes delivered via a
 * guaranteed-delivered `batch.instruct` item (wave-close review Findings 1+2, EPIC 7: a note only
 * ever RENDERED into a conditionally-delivered `batch.incomplete` prompt is deliberately left
 * unconsumed, so a dropped resume_chief prompt can never silently lose it).
 */
export namespace OrgNote {
  /**
   * Append a side-channel note targeting `target` (an agent name, `"*"`, or the org's ceo — see
   * `OrgState.Note`). `org` is accepted for signature symmetry with the run's other org-aware
   * mutators (`OrgRunner.decide`, etc.) and as a natural extension point for future target
   * validation; today `append` accepts any `target` string unconditionally — an unmatched target
   * is simply never surfaced (see `OrgRunner.stagePromptFor`), never a validation error here, so a
   * note aimed at a not-yet-reached or renamed stage doesn't reject the call.
   */
  export async function append(
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    input: { target: string; text: string; from?: string },
  ): Promise<OrgState.Run> {
    void org
    const note: OrgState.Note = {
      id: randomUUID(),
      target: input.target,
      text: input.text,
      from: input.from,
      ts: new Date().toISOString(),
    }
    return OrgState.update(projectDir, runID, (run) => {
      run.notes = [...(run.notes ?? []), note]
    })
  }
}
