// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { Config } from "@/config/config"
import { KiloCostPropagation } from "@/kilocode/session/cost-propagation"
import { OrgSchema } from "./schema"
import { OrgRunner } from "./runner"
import { OrgState } from "./state"

/** Two-arg tryPromise so the real Error (with its readable message) lands in the failure channel;
 * bare single-arg tryPromise wraps rejections in UnknownError whose .message is a fixed opaque string,
 * which would reduce every expected config/runner error to noise before it reaches the CEO agent. */
export const tryOrg = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const load = (projectDir: string) => tryOrg(() => OrgSchema.loadOrganization(projectDir))

const guardCeo = (org: OrgSchema.Organization, agent: string) =>
  agent === org.ceo
    ? Effect.void
    : Effect.fail(new Error(`org tools are reserved for the CEO agent "${org.ceo}" (called by "${agent}")`))

function result(title: string, body: unknown) {
  return { title, metadata: {}, output: typeof body === "string" ? body : JSON.stringify(body, null, 2) }
}

const StartParameters = Schema.Struct({
  idea: Schema.String.annotate({ description: "The app idea, verbatim from the user" }),
})

export const OrgStartTool = Tool.define(
  "org_start",
  Effect.gen(function* () {
    return {
      description:
        "Start a new organization pipeline run from an app idea. Returns the run_id. Then call org_advance to get the first stage instruction.",
      parameters: StartParameters,
      execute: (params: Schema.Schema.Type<typeof StartParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const run = yield* tryOrg(() => OrgRunner.start(dir, org, params.idea))
          return result(`org run ${run.runID}`, {
            run_id: run.runID,
            pipeline: org.pipeline,
            next: "call org_advance with this run_id",
          })
        }).pipe(Effect.orDie),
    }
  }),
)

const AdvanceParameters = Schema.Struct({
  run_id: Schema.String,
  task_id: Schema.optional(Schema.String).annotate({
    description: "The task session id of the chief task you just ran for the current stage",
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
          const advance = yield* tryOrg(() =>
            OrgRunner.advance(deps, dir, org, params.run_id, { taskID: params.task_id }),
          )
          switch (advance.kind) {
            case "instruct": {
              const resumable = advance.resumeTaskID ? yield* isResumable(advance.resumeTaskID, ctx) : false
              return result(`stage: ${advance.stage}`, {
                action: "run_task",
                stage: advance.stage,
                task_call: {
                  subagent_type: advance.chief,
                  description: `${advance.stage} stage`,
                  prompt: advance.taskPrompt,
                  ...(resumable ? { task_id: advance.resumeTaskID } : {}),
                },
                ...(advance.resumeTaskID && !resumable
                  ? {
                      note: "previous chief session is not resumable from this session; run the task without task_id (fresh chief session)",
                    }
                  : {}),
                then: "when the chief's task returns (whether or not it said READY), call org_advance again with task_id set to the task session id",
              })
            }
            case "gate":
              return result(`gate: ${advance.stage}`, {
                action: "human_gate",
                stage: advance.stage,
                deliverable: advance.deliverablePath,
                instructions:
                  "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision.",
              })
            case "incomplete": {
              const resumable = advance.resumeTaskID ? yield* isResumable(advance.resumeTaskID, ctx) : false
              return result(`incomplete: ${advance.stage}`, {
                action: "resume_chief",
                stage: advance.stage,
                reason: advance.reason,
                ...(resumable ? { resume_task_id: advance.resumeTaskID } : {}),
                // kilocode_change - whenever no resumable session exists (unresumable id OR one was
                // never recorded, e.g. a crash before the first advance-with-task_id), hand the CEO
                // a full task_call so the fresh chief session is briefed with idea/priors context.
                ...(!resumable && advance.chief && advance.taskPrompt
                  ? {
                      task_call: {
                        subagent_type: advance.chief,
                        description: `${advance.stage} stage (fresh session)`,
                        prompt: advance.taskPrompt,
                      },
                    }
                  : {}),
                ...(advance.resumeTaskID && !resumable
                  ? {
                      note: "previous chief session is not resumable; use the provided task_call to start a fresh, fully-briefed chief session",
                    }
                  : {}),
                then: "when the chief's task returns, call org_advance again with task_id set to the task session id",
              })
            }
            case "halted":
              return result("halted", { action: "halted", reason: advance.reason })
            case "done":
              return result("done", { action: "done", note: "pipeline complete; present the final package to the user" })
          }
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
})

export const OrgDecisionTool = Tool.define(
  "org_decision",
  Effect.gen(function* () {
    return {
      description: "Record the user's gate decision for the stage awaiting approval (approve / no-go / revise).",
      parameters: DecisionParameters,
      execute: (params: Schema.Schema.Type<typeof DecisionParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const run = yield* tryOrg(() => OrgRunner.decide(dir, org, params.run_id, params.decision, params.note))
          return result(`decision: ${params.decision}`, { status: run.status, next: "call org_advance" })
        }).pipe(Effect.orDie),
    }
  }),
)

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
          return result(`run ${params.run_id}`, status)
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
          const { taskID } = yield* tryOrg(() => OrgRunner.stop(dir, org, params.run_id, params.reason))
          if (!taskID) {
            return result("stopped", { action: "stopped", reason: params.reason, note: "no stage was running" })
          }
          // Best-effort: the halt is already persisted, so a cancellation failure must degrade to
          // a note rather than fail the stop.
          const cancelled = yield* runState
            .cancel(SessionID.make(taskID))
            .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
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
