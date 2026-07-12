// kilocode_change - new file
import { Effect, Schema } from "effect"
import { Option } from "effect"
import * as Log from "@opencode-ai/core/util/log" // kilocode_change - W6.2: best-effort postmortem logging
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { Config } from "@/config/config"
import { KiloCostPropagation } from "@/kilocode/session/cost-propagation"
import { OrgSchema } from "./schema"
import { OrgRunner } from "./runner"
import { OrgState, OrgNote } from "./state"
import { OrgAudit } from "./audit" // kilocode_change - W6.2: postmortem's gate-decision trail
import { OrgPostmortem } from "./postmortem" // kilocode_change - W6.2: postrun postmortem hook
import { OrgMemory } from "./memory" // kilocode_change - W6.2: companion lesson in the org memory pool
import { OrgDriver } from "./driver" // kilocode_change - SP1 headless loop attachment
import { Provider } from "@/provider/provider" // kilocode_change - optional evaluator small-model resolver
import type { TaskPromptOps } from "@/tool/task"

// kilocode_change start - W6.2: postrun postmortem hook.
const postmortemLog = Log.create({ service: "kilocode-org-postmortem" })

/**
 * Best-effort postmortem recorder, shared by every run-END choke point (`OrgAdvanceTool`'s
 * `done`/`halted` results, `OrgDecisionTool`'s no-go path, `OrgStopTool`'s unconditional halt).
 * Called INSIDE `withRunLock`, AFTER the run-ending result each tool returns is already fully
 * determined - so this function's own I/O can only run once the state write that produced that
 * result has landed, and nothing it does can change what already got returned.
 *
 * CRITICAL INVARIANT: this function must NEVER throw and must NEVER be awaited for its result to
 * shape a tool's response. The entire body is wrapped in try/catch: any failure (reading the run,
 * reading the audit trail, writing lessons.md, saving the org-memory lesson) is logged via
 * `Log.warn` and swallowed. A caller only ever needs `void recordPostmortem(...)` /
 * `await recordPostmortem(...)` for sequencing (so it stays inside the lock) - its outcome is
 * never inspected or propagated.
 *
 * Fire-once is NOT this function's job: it re-reads state and unconditionally calls
 * `OrgPostmortem.write` (whose own marker check is the actual fire-once guarantee - see
 * postmortem.ts) and `OrgMemory.save` (keyed by `run.runID`, which the underlying `Memory.remember`
 * upserts in place rather than duplicating - see memory.ts/kilo-memory). So a re-entrant call for
 * the same run_id (e.g. a second `org_advance` on an already-completed run) is safe to make again.
 */
async function recordPostmortem(dir: string, org: OrgSchema.Organization, runID: string): Promise<void> {
  try {
    const run = await OrgState.read(dir, runID)
    const summary = OrgState.runSummary(run)
    const audit = await OrgAudit.read(dir, runID)
    await OrgPostmortem.write(dir, run, summary, audit)
    await OrgMemory.save(dir, {
      text: `${run.idea}: ${OrgPostmortem.outcome(run)}, $${summary.totalCost}`,
      dept: OrgPostmortem.keyStage(run),
      key: run.runID,
    })
    // kilocode_change start - W6.3 fix: index THIS completed run's deliverables so `org_search`
    // is actually functional against a real embedder (before this, nothing ever indexed org
    // deliverables in production, so org_search queried an always-empty store).
    //
    // BEST-EFFORT and NON-BLOCKING to completion by construction:
    //   - It runs strictly AFTER the run-ending result was already computed by the caller (inside
    //     withRunLock, after OrgRunner.advance/decide/stop returned), so neither its latency nor a
    //     failure can change what org_advance/org_decision/org_stop returns.
    //   - `orgRagServices` NEVER throws: it catches every failure mode (no key, indexing disabled,
    //     LanceDB unavailable) and returns `undefined`, leaving org-RAG gracefully INERT - the
    //     common case when no embedder is configured indexes nothing and adds ~one cheap config
    //     read of latency.
    //   - A configured-but-failing/slow embedder throws or stalls only INSIDE this try, whose
    //     catch below swallows it (the run already completed); it can never break run completion.
    //   - `indexRun` uses stable per-chunk point ids, so a re-entrant recordPostmortem for the
    //     same run (e.g. a second org_advance on an already-done run) re-indexes idempotently
    //     rather than duplicating points.
    // KiloIndexing + OrgRag are imported DYNAMICALLY (mirroring org-search.ts) to keep the heavy
    // indexing module out of the tool registry's module-init graph and avoid the control-plane
    // TDZ cycle that a static import there re-triggers.
    const { KiloIndexing } = await import("@/kilocode/indexing")
    const services = await KiloIndexing.orgRagServices(dir)
    if (services) {
      const { OrgRag } = await import("./rag")
      await OrgRag.indexRun(dir, services.embedder, services.store, runID)
    }
    // kilocode_change end
  } catch (err) {
    postmortemLog.warn("org postmortem failed (best-effort; run result unaffected)", {
      runID,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
// kilocode_change end

/** Two-arg tryPromise so the real Error (with its readable message) lands in the failure channel;
 * bare single-arg tryPromise wraps rejections in UnknownError whose .message is a fixed opaque string,
 * which would reduce every expected config/runner error to noise before it reaches the CEO agent. */
export const tryOrg = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

// kilocode_change start - W0-R2: serialize the MUTATING org tools per run_id.
// OrgState.update and OrgAudit.append are unlocked read-modify-write/append (see their own doc
// comments) on the stated assumption that a single CEO session calls org tools serially. The AI
// SDK breaks that assumption: it can execute a single assistant step's tool calls concurrently,
// so two org_advance-shaped calls (or an org_advance racing an org_stop) against the SAME run_id
// can interleave their read...write cycles. Concretely: org_stop reads state.json (status
// "active"), writes it back with status "halted"; if a stale in-flight org_advance had already
// read the pre-halt state.json and writes AFTER the stop, its write silently reintroduces
// status "active" - the emergency stop is undone with no error and no trace beyond the audit log
// disagreeing with state.json.
//
// Fix: a per-run_id async mutex, held for the full mutating body of org_advance / org_decision /
// org_stop (every read...modify...write cycle those tools perform against a given run's
// state.json/approvals.json). This lives at the tool boundary (not inside OrgRunner, which stays
// pure and synchronously-composable for unit testing) because the hazard is specifically about
// concurrent I/O against the same files, which only exists once tool execution enters the async,
// potentially-concurrent AI SDK step.
//
// org_start is exempt: it always creates a brand-new run directory (OrgState.create), so there is
// no existing run_id for another call to race against; nothing to serialize until the id exists.
//
// org_status is deliberately left UNLOCKED. It never mutates - list()/read()/OrgAudit.read() are
// pure reads - and Node's single-threaded event loop means a read interleaved with a
// lock-holder's write only ever observes the state.json/approvals.json from strictly before or
// strictly after that writer's atomic rename (Filesystem.write renames into place), never a torn
// read. A concurrent org_status can therefore return a snapshot that's stale by one in-flight
// write, which is the same staleness any read-after-a-later-write already has; it cannot lose an
// update or corrupt a file. Locking it too would only add queueing latency for a caller that's
// explicitly asking for a point-in-time dry-run inspection, with no correctness upside.
//
// Residual (NOT solved here, by design): this mutex is process-local. It does nothing to
// coordinate a second opencode instance/process pointed at the same project directory running
// org tools against the same run_id concurrently - that hazard needs cross-process locking (e.g.
// an OS file lock or a lockfile-with-pid protocol) and is a separate, larger piece of work than
// this fix. Flagged in tracked-followups.md as a residual, not tracked as a new TRACK item, since
// it's a known, intentionally-deferred boundary of this fix rather than a newly discovered gap.
const runLocks = new Map<string, Promise<unknown>>()

/** Standard promise-chain mutex keyed by run_id: chains `fn` after the current tail for that key
 * and republishes the new tail, so callers racing on the SAME run_id serialize while callers on
 * DIFFERENT run_ids never wait on each other. The tail promise is always allowed to settle
 * (fulfilled or rejected) before the next link runs - `.catch(() => {})` on the stored tail
 * absorbs failures so one caller's rejection can never wedge the queue for the next caller on the
 * same run_id; the actual error still propagates to the ORIGINAL caller via the returned promise. */
export function withRunLock<A>(runID: string, fn: () => Promise<A>): Promise<A> {
  const tail = runLocks.get(runID) ?? Promise.resolve()
  const result = tail.then(fn, fn)
  runLocks.set(
    runID,
    result.catch(() => {}),
  )
  return result
}
// kilocode_change end

// kilocode_change - exported (was module-private) so org-memory-save.ts/org-recall.ts (W6.1) can
// reuse the SAME dir-loading/CEO-guard/result-shaping logic instead of duplicating it a third time.
export const load = (projectDir: string) => tryOrg(() => OrgSchema.loadOrganization(projectDir))

export const guardCeo = (org: OrgSchema.Organization, agent: string) =>
  agent === org.ceo
    ? Effect.void
    : Effect.fail(new Error(`org tools are reserved for the CEO agent "${org.ceo}" (called by "${agent}")`))

export function result(title: string, body: unknown) {
  return { title, metadata: {}, output: typeof body === "string" ? body : JSON.stringify(body, null, 2) }
}

const StartParameters = Schema.Struct({
  idea: Schema.String.annotate({ description: "The idea/brief, verbatim from the user" }),
  mode: Schema.optional(Schema.String).annotate({
    description: "Optional mode string, e.g. 'mvp', consulted by stage `when` conditions",
  }),
})

export const OrgStartTool = Tool.define(
  "org_start",
  Effect.gen(function* () {
    return {
      description:
        "Start a new organization pipeline run from an idea/brief. Returns the run_id. Then call org_advance to get the first stage instruction.",
      parameters: StartParameters,
      execute: (params: Schema.Schema.Type<typeof StartParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const run = yield* tryOrg(() => OrgRunner.start(dir, org, params.idea, params.mode, ctx.sessionID))
          return result(`org run ${run.runID}`, {
            run_id: run.runID,
            pipeline: org.pipeline,
            next: "call org_advance with this run_id",
          })
        }).pipe(Effect.orDie),
    }
  }),
)

const PlanStageParameters = Schema.Struct({
  stage: Schema.String,
  objective: Schema.String,
  criteria: Schema.Array(Schema.String),
  agents: Schema.optional(Schema.Array(Schema.String)),
})

const PlanParameters = Schema.Struct({
  run_id: Schema.String,
  stages: Schema.Array(PlanStageParameters).annotate({
    description: "Exactly one objective, measurable criteria list, and optional agent list per pipeline stage",
  }),
})

export const OrgPlanTool = Tool.define(
  "org_plan",
  Effect.gen(function* () {
    return {
      description:
        "Commit or replace the one-shot autonomous execution plan while its first human gate is awaiting approval. The user may edit criteria before approving; approval then starts loop mode.",
      parameters: PlanParameters,
      execute: (params: Schema.Schema.Type<typeof PlanParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const run = yield* tryOrg(() =>
            withRunLock(params.run_id, async () => {
              const updated = await OrgRunner.commitPlan(dir, org, params.run_id, params.stages)
              return updated
            }),
          )
          return result(`autonomous plan: ${params.run_id}`, {
            run_id: params.run_id,
            status: run.status,
            auto: run.auto,
            stages: params.stages,
            next: "present this editable plan to the user, then call org_decision approve on the plan gate",
          })
        }).pipe(Effect.orDie),
    }
  }),
)

const AdvanceParameters = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "The task session id of the chief task you just ran for the current stage (single-stage convenience; use task_results after a parallel fan-out)",
  }),
  // kilocode_change - W4.6: after spawning a run_tasks fan-out in parallel, the CEO reports one
  // {stage, task_id} per finished task so each stage settles with ITS OWN chief's cost/session.
  task_results: Schema.optional(
    Schema.Array(Schema.Struct({ stage: Schema.String, task_id: Schema.String })),
  ).annotate({
    description:
      "After spawning multiple tasks from a run_tasks batch in parallel, report each finished task as {stage, task_id} so its stage is settled with its own chief's result",
  }),
})

export const OrgAdvanceTool = Tool.define(
  "org_advance",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    // kilocode_change start - after a CLI restart, a persisted taskID from state.json is no
    // longer a child of the current session (src/tool/task.ts rejects such resumes), so a
    // resumeTaskID must be verified resumable before we hand it back to the CEO.
    const isResumable = (taskID: string | undefined, ctx: Tool.Context) =>
      Effect.gen(function* () {
        if (!taskID || !taskID.startsWith("ses")) return false
        const session = yield* sessions
          .get(SessionID.make(taskID))
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        return session !== undefined && session.parentID === ctx.sessionID
      })
    // kilocode_change end
    return {
      description:
        "Advance the organization pipeline. Validates the current stage's deliverable, enforces gates, and returns the next action: an exact task-tool call to run a department chief, a human gate to resolve via org_decision, or done/halted. Pass task_id after a chief task finishes so cost and resume tracking work.",
      parameters: AdvanceParameters,
      execute: (params: Schema.Schema.Type<typeof AdvanceParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const deps: OrgRunner.Deps = {
            // Best-effort: a malformed model-provided task_id must degrade to unknown cost,
            // not reject the whole advance (SessionID.make throws synchronously outside the Effect).
            costOf: (taskID) =>
              taskID.startsWith("ses")
                ? Effect.runPromise(
                    KiloCostPropagation.childCost(sessions, SessionID.make(taskID)).pipe(
                      Effect.catch(() => Effect.succeed(undefined)),
                    ),
                  ).catch(() => undefined)
                : Promise.resolve(undefined),
          }
          // kilocode_change - W0-R2: serialize the read-modify-write body against other mutating
          // org tool calls on the SAME run_id (see withRunLock's doc comment above).
          // kilocode_change - W4.6: map the CEO's single `task_id` and/or per-stage `task_results`
          // onto the runner's widened input, so a parallel fan-out threads each chief's result to its
          // OWN stage (renaming the tool-facing `task_id` -> runner-facing `taskID`).
          const batch = yield* tryOrg(() =>
            withRunLock(params.run_id, async () => {
              const advanced = await OrgRunner.advance(deps, dir, org, params.run_id, {
                taskID: params.task_id,
                taskResults: params.task_results?.map((r) => ({ stage: r.stage, taskID: r.task_id })),
              })
              // kilocode_change start - W6.2: best-effort postmortem at the run-END choke point.
              // Runs AFTER `advanced` is fully computed (still inside the lock), so a postmortem
              // failure can never change the Batch this tool returns. Covers BOTH end states:
              // `done` (normal completion) and `halted` (budget/timeout/failed-stage halts).
              if (advanced.done || advanced.halted) {
                await recordPostmortem(dir, org, params.run_id)
              }
              // kilocode_change end
              return advanced
            }),
          )
          // kilocode_change - W4.6: the Batch (parallel instructs + at most one serialized blocker)
          // maps to a widened action vocabulary. Precedence: halted -> done -> run_tasks (fan-out; a
          // co-existing gate/incomplete rides along as an informational pending_gate/pending_incomplete
          // so it is never lost) -> human_gate -> resume_chief -> waiting. Instructs now take priority
          // over a co-existing blocker because independent ready/revise work should start THIS turn
          // while a serialized gate/incomplete is only advisory until its own stage is the sole blocker.
          // With maxConcurrency:1 there is at most one instruct AND at most one blocker, and the two
          // never co-exist (a single active stage is either instructed or blocked), so this collapses
          // to a single-element run_tasks / single blocker — behavior stays effectively sequential.
          if (batch.halted) {
            return result("halted", { action: "halted", reason: batch.halted.reason })
          }
          if (batch.done) {
            return result("done", { action: "done", note: "pipeline complete; present the final package to the user" })
          }

          // Build the human_gate payload for a GateItem (shared by the standalone gate action and the
          // informational pending_gate that rides alongside a run_tasks fan-out).
          const gatePayload = (gate: OrgRunner.GateItem) => {
            const baseInstructions =
              "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision."
            return {
              stage: gate.stage,
              deliverable: gate.deliverablePath,
              ...(gate.note ? { budget_note: gate.note } : {}),
              instructions: gate.note
                ? `${baseInstructions} This gate was triggered by budget: ${gate.note}. Tell the user the cumulative spend before asking for a decision.`
                : baseInstructions,
            }
          }

          if (batch.instruct.length > 0) {
            // One task-tool call per instruct item, each resumable-checked individually. The CEO must
            // spawn ALL of these in the SAME turn as parallel `task` calls, wait for every task, then
            // call org_advance again with task_results: one {stage, task_id} per spawned task.
            const tasks = []
            for (const item of batch.instruct) {
              const resumable = item.resumeTaskID ? yield* isResumable(item.resumeTaskID, ctx) : false
              tasks.push({
                stage: item.stage,
                subagent_type: item.chief,
                description: `${item.stage} stage`,
                prompt: item.taskPrompt,
                ...(resumable ? { task_id: item.resumeTaskID } : {}),
                ...(item.resumeTaskID && !resumable
                  ? { note: "previous chief session is not resumable from this session; run without task_id (fresh chief session)" }
                  : {}),
              })
            }
            const stages = batch.instruct.map((i) => i.stage).join(", ")
            let then =
              "Spawn ALL of these tasks in the SAME turn as parallel `task` tool calls (do not spawn one, wait, then the next). Wait for every task to return, then call org_advance again with task_results set to [{stage, task_id}] for each finished task."
            const extra: Record<string, unknown> = {}
            // A co-existing serialized blocker (an independent branch gated/incomplete while others run)
            // is surfaced informationally so it isn't lost; the CEO resolves it once it becomes the sole
            // blocker on a later advance. Mentioned in `then:` so the CEO knows it is pending.
            if (batch.gate) {
              extra.pending_gate = gatePayload(batch.gate)
              then += ` NOTE: stage "${batch.gate.stage}" is ALSO awaiting a human gate (pending_gate); it will be surfaced as a human_gate to resolve once these tasks settle.`
            }
            if (batch.incomplete) {
              // W4-Finding#5: a stalled fan-out branch is now only re-settled when the CEO re-runs it
              // (see runner's reported-or-revise settle selection), so it MUST be re-runnable here.
              // Carry the SAME resume info the standalone resume_chief action uses so the CEO can
              // re-spawn this stalled stage's chief IN THE SAME parallel turn as the other tasks and
              // report its task_id in the next task_results — a real re-run that legitimately
              // increments attempts, so the branch can complete or fail after real retries rather
              // than stall forever (which would keep the run from ever reaching done).
              const inc = batch.incomplete
              const resumable = inc.resumeTaskID ? yield* isResumable(inc.resumeTaskID, ctx) : false
              extra.pending_incomplete = {
                stage: inc.stage,
                reason: inc.reason,
                subagent_type: inc.chief,
                description: `${inc.stage} stage (re-spawn stalled branch)`,
                prompt: inc.taskPrompt,
                ...(resumable ? { task_id: inc.resumeTaskID } : {}),
                ...(inc.resumeTaskID && !resumable
                  ? { note: "previous chief session is not resumable from this session; re-spawn without task_id (fresh chief session)" }
                  : {}),
              }
              then += ` NOTE: stage "${inc.stage}" is ALSO incomplete (pending_incomplete). Re-spawn its chief in THIS SAME parallel turn using pending_incomplete (subagent_type + prompt, and task_id if present) and include its task_id in the next task_results.`
            }
            return result(`run_tasks: ${stages}`, { action: "run_tasks", tasks, ...extra, then })
          }

          if (batch.gate) {
            return result(`gate: ${batch.gate.stage}`, { action: "human_gate", ...gatePayload(batch.gate) })
          }
          if (batch.incomplete) {
            const inc = batch.incomplete
            const resumable = inc.resumeTaskID ? yield* isResumable(inc.resumeTaskID, ctx) : false
            return result(`incomplete: ${inc.stage}`, {
              action: "resume_chief",
              stage: inc.stage,
              reason: inc.reason,
              ...(resumable ? { resume_task_id: inc.resumeTaskID } : {}),
              // kilocode_change - whenever no resumable session exists (unresumable id OR one was
              // never recorded, e.g. a crash before the first advance-with-task_id), hand the CEO
              // a full task_call so the fresh chief session is briefed with idea/priors context.
              ...(!resumable && inc.chief && inc.taskPrompt
                ? {
                    task_call: {
                      subagent_type: inc.chief,
                      description: `${inc.stage} stage (fresh session)`,
                      prompt: inc.taskPrompt,
                    },
                  }
                : {}),
              ...(inc.resumeTaskID && !resumable
                ? {
                    note: "previous chief session is not resumable; use the provided task_call to start a fresh, fully-briefed chief session",
                  }
                : {}),
              then: "when the chief's task returns, call org_advance again with task_id set to the task session id",
            })
          }
          // No instructs, no blocker: nothing to spawn this call while other work is still in flight
          // (the runner's defensive empty-active batch). Tell the CEO to poll again once a running
          // task returns; the runner will fan out / gate / finish on a later call.
          return result("waiting", {
            action: "waiting",
            then: "one or more stages are still running; when their tasks return call org_advance again with their task_results",
          })
        }).pipe(Effect.orDie),
    }
  }),
)

const DecisionParameters = Schema.Struct({
  run_id: Schema.String,
  decision: Schema.Literals(["approve", "no-go", "revise"]),
  note: Schema.optional(Schema.String).annotate({
    description: "Required for revise: what the user wants changed",
  }),
  // kilocode_change - E7-R2: optional target stage, for a parallel DAG with multiple stages
  // awaiting_approval at once. Omit to fall back to the first awaiting stage (unchanged behavior).
  stage: Schema.optional(Schema.String).annotate({
    description:
      "Target a specific stage awaiting approval (needed when multiple stages are awaiting approval at once, e.g. a parallel DAG). The human_gate response's `stage` field names it. Omit to resolve the first awaiting stage.",
  }),
})

export const OrgDecisionTool = Tool.define(
  "org_decision",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const provider = yield* Effect.serviceOption(Provider.Service)
    return {
      description: "Record the user's gate decision for the stage awaiting approval (approve / no-go / revise).",
      parameters: DecisionParameters,
      execute: (params: Schema.Schema.Type<typeof DecisionParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          // kilocode_change - W0-R2: serialize against other mutating org tool calls on this run_id.
          const run = yield* tryOrg(() =>
            withRunLock(params.run_id, async () => {
              const updated = await OrgRunner.decide(
                dir,
                org,
                params.run_id,
                params.decision,
                params.note,
                params.stage,
              )
              // kilocode_change start - W6.2: a "no-go" decision halts the run right here; record
              // the postmortem now, AFTER `updated` is fully computed, best-effort.
              if (updated.status === "halted") {
                await recordPostmortem(dir, org, params.run_id)
              }
              // kilocode_change end
              return updated
            }),
          )
          const promptOps = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (run.status === "active" && run.auto === true && promptOps) {
            const bridge = yield* Effect.promise(() => import("./driver-session"))
            const runtime = OrgDriver.sessionRuntime({
              ownerSessionID: run.ownerSessionID ?? ctx.sessionID,
              bridge: bridge.effectSessionBridge({
                sessions,
                prompts: promptOps,
                provider: Option.getOrUndefined(provider),
              }),
            })
            void OrgDriver.attach({
              projectDir: dir,
              org,
              runID: params.run_id,
              runtime,
              lock: (fn) => withRunLock(params.run_id, fn),
            }).catch((error) =>
              postmortemLog.warn("autonomous driver failed", {
                runID: params.run_id,
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          }
          return result(`decision: ${params.decision}`, { status: run.status, next: "call org_advance" })
        }).pipe(Effect.orDie),
    }
  }),
)

// kilocode_change start - Task 7.3 (EPIC 7): the org_note side-channel tool. Mirrors
// OrgDecisionTool's shape exactly (guardCeo -> withRunLock -> a single OrgState-backed mutation),
// but never touches run.stages/status/gate - it only appends to run.notes (OrgNote.append), which
// OrgRunner.stagePromptFor later surfaces read-only into a matching stage's NEXT instruct. Does
// NOT interrupt the currently-running stage.
const NoteParameters = Schema.Struct({
  run_id: Schema.String,
  target_agent: Schema.String.annotate({
    description: 'Agent name to address (a chief/worker name), "*" for every stage, or the ceo agent name',
  }),
  text: Schema.String.annotate({ description: "The note text, verbatim from the user" }),
})

export const OrgNoteTool = Tool.define(
  "org_note",
  Effect.gen(function* () {
    return {
      description:
        "Queue a side-channel note for a running organization pipeline. It surfaces read-only inside target_agent's NEXT stage instruction (or every stage's, for \"*\"/the ceo) - it does NOT interrupt the currently-running stage or change any gate/decision. Use for a user message directed at an agent while a pipeline stage is in flight.",
      parameters: NoteParameters,
      execute: (params: Schema.Schema.Type<typeof NoteParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          // kilocode_change - W0-R2: serialize against other mutating org tool calls on this run_id
          // (see withRunLock's doc comment above OrgAdvanceTool).
          yield* tryOrg(() =>
            withRunLock(params.run_id, () =>
              OrgNote.append(dir, org, params.run_id, { target: params.target_agent, text: params.text, from: ctx.agent }),
            ),
          )
          return result(`note queued for ${params.target_agent}`, { ok: true })
        }).pipe(Effect.orDie),
    }
  }),
)
// kilocode_change end

const StatusParameters = Schema.Struct({
  run_id: Schema.optional(Schema.String),
})

export const OrgStatusTool = Tool.define(
  "org_status",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description:
        "Show the organization chart and validation against configured agents (no run_id), or the state and cost breakdown of a run (with run_id). Use for dry-run inspection of the org config.",
      parameters: StatusParameters,
      execute: (params: Schema.Schema.Type<typeof StatusParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          if (!params.run_id) {
            const runs = yield* tryOrg(() => OrgState.list(dir))
            // kilocode_change - cross-check the org chart against the actually-configured
            // agents (project markdown files merge into cfg.agent), matching what
            // OrgSchema.crossCheck already validates in tests.
            const cfg = yield* config.get()
            const view = Object.fromEntries(
              Object.entries(cfg.agent ?? {}).map(([name, a]) => [
                name,
                { mode: a.mode, subordinates: (a as { subordinates?: readonly string[] }).subordinates },
              ]),
            )
            const issues = OrgSchema.crossCheck(org, view)
            return result("organization", { organization: org, runs, issues })
          }
          const status = yield* tryOrg(() => OrgRunner.status(dir, org, params.run_id!))
          const budget = OrgSchema.resolveBudget(org)
          const spent = status.totalCost
          return result(`run ${params.run_id}`, {
            ...status,
            budget: {
              run: budget.run,
              stage: budget.stage,
              escalationThreshold: budget.escalationThreshold,
              retries: budget.retries,
              spent,
              remaining: Math.max(0, budget.run - spent),
            },
          })
        }).pipe(Effect.orDie),
    }
  }),
)

const StopParameters = Schema.Struct({
  run_id: Schema.String,
  reason: Schema.String.annotate({ description: "Why the run is being stopped, verbatim from the user" }),
})

export const OrgStopTool = Tool.define(
  "org_stop",
  Effect.gen(function* () {
    const runState = yield* SessionRunState.Service
    return {
      description:
        "Emergency stop: immediately halts the organization run, regardless of what is currently in flight. Records the reason and best-effort cancels the running chief's session. Use when the user asks to stop or abort the run.",
      parameters: StopParameters,
      execute: (params: Schema.Schema.Type<typeof StopParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          // kilocode_change - W0-R2: serialize against other mutating org tool calls on this
          // run_id. org_stop still waits for its turn behind an in-flight org_advance/org_decision
          // on the SAME run_id (there is no true priority/preemption in a promise-chain mutex) -
          // but that is exactly what fixes the hazard: once org_stop's write runs, it is
          // guaranteed to be the LAST write for this run_id in program order, so a stale advance
          // that started before the stop can no longer clobber it after. Before this fix the two
          // writes could interleave in either order; now they are strictly ordered by the queue.
          const { stage, taskID } = yield* tryOrg(() =>
            withRunLock(params.run_id, async () => {
              const stopped = await OrgRunner.stop(dir, org, params.run_id, params.reason)
              // kilocode_change start - W6.2: org_stop always halts the run; record the postmortem
              // now, AFTER `stopped` is fully computed, best-effort.
              await recordPostmortem(dir, org, params.run_id)
              // kilocode_change end
              return stopped
            }),
          )
          if (!stage) {
            return result("stopped", { action: "stopped", reason: params.reason, note: "no stage was running" })
          }
          if (!taskID) {
            return result("stopped", {
              action: "stopped",
              reason: params.reason,
              note: `stage "${stage}" was running but no task session was recorded; nothing to cancel`,
            })
          }
          // Best-effort: the halt is already persisted, so cancellation problems must degrade to
          // a note rather than fail the stop. The startsWith guard mirrors org_advance's
          // isResumable/costOf guards: the taskID was persisted verbatim from model input, and
          // SessionID.make throws synchronously on non-"ses" strings — while evaluating the
          // argument, before the catch below exists.
          const cancelled = taskID.startsWith("ses")
            ? yield* runState
                .cancel(SessionID.make(taskID))
                .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
            : false
          return result("stopped", {
            action: "stopped",
            reason: params.reason,
            ...(cancelled ? { cancelled_session: taskID } : {}),
            note: cancelled
              ? "the running chief's session was cancelled"
              : "live session cancellation failed; the running chief will finish its current turn",
          })
        }).pipe(Effect.orDie),
    }
  }),
)
