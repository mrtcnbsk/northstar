// kilocode_change - new file
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { OrgState } from "@/kilocode/organization/state"
import { OrgAudit } from "@/kilocode/organization/audit"
import { OrgSchema } from "@/kilocode/organization/schema"
import { OrgRunner } from "@/kilocode/organization/runner"
import { OrgNote } from "@/kilocode/organization/state"
import { withRunLock } from "@/kilocode/organization/tools"
import { OrgDriver } from "@/kilocode/organization/driver"
import { OrgWorkspace } from "@/kilocode/organization/workspace"
import { OrgArtifacts } from "@/kilocode/organization/artifacts"
import { effectSessionBridge } from "@/kilocode/organization/driver-session"
import { Session } from "@/session/session"
import * as SessionPrompt from "@/session/prompt"
import { Provider } from "@/provider/provider"
import type {
  OrgRunDecisionPayload,
  OrgRunDetailResponse,
  OrgRunNotePayload,
  OrgRunPausePayload,
  OrgRunPlanPayload,
  OrgRunResumePayload,
  OrgRunsListResponse,
  OrgRunStopPayload,
  OrgRunQuery,
} from "../groups/org-runs"

/**
 * Pure, org-free view builders over run state.json + approvals.json. Kept separate from the Effect
 * handler wiring so they can be unit-tested directly with tmpdir fixtures (see test/kilocode/server).
 * Cost math is delegated to OrgState.runSummary/stageCost — never re-derived here.
 */
type RunSummaryEntry = (typeof OrgRunsListResponse.Type)["runs"][number]

export namespace OrgRunsView {
  /**
   * Each run is read in isolation: a single corrupt/unreadable/schema-invalid state.json (or a
   * stray subdirectory with no state.json at all) must not take down the whole list. On any
   * per-run failure we log a warning with the offending runID + reason and skip that run --
   * healthy runs still render. See Wave 3 observability review (Bug A).
   */
  export async function list(projectDir: string, organizationID?: string): Promise<typeof OrgRunsListResponse.Type> {
    if (organizationID) {
      const organization = await OrgWorkspace.resolve(projectDir, organizationID)
      return OrgWorkspace.run(organization, () => list(projectDir))
    }
    const ids = await OrgState.list(projectDir) // already reverse-sorted (newest first); [] when no runs dir
    const runs = await Promise.all(
      ids.map(async (runID): Promise<RunSummaryEntry | null> => {
        try {
          const run = await OrgState.read(projectDir, runID)
          const summary = OrgState.runSummary(run)
          return {
            runID: run.runID,
            idea: run.idea,
            status: run.status,
            createdAt: run.createdAt,
            totalCost: summary.totalCost,
            stageCount: summary.stageCount,
            currentStage: summary.currentStage,
            awaitingGate: summary.awaitingGate,
          }
        } catch (e) {
          console.warn(`[org-runs] skipping run "${runID}" from list: ${e instanceof Error ? e.message : String(e)}`)
          return null
        }
      }),
    )
    // Newest-first ordering comes from OrgState.list's sort; filtering preserves relative order.
    return { runs: runs.filter((r): r is RunSummaryEntry => r !== null) }
  }

  /** Throws OrgState.NotFound when the run genuinely does not exist; any other thrown error means
   * the run is present but corrupt/unreadable, and callers must not treat that as "not found". */
  export async function detail(
    projectDir: string,
    runID: string,
    organizationID?: string,
  ): Promise<typeof OrgRunDetailResponse.Type> {
    if (organizationID) {
      const organization = await OrgWorkspace.resolve(projectDir, organizationID)
      return OrgWorkspace.run(organization, () => detail(projectDir, runID))
    }
    const run = await OrgState.read(projectDir, runID) // throws OrgState.NotFound on ENOENT/traversal
    const audit = await OrgAudit.read(projectDir, runID).catch((e: unknown) => {
      // approvals.json is supplementary: a corrupt/unreadable audit trail degrades to an empty
      // list rather than failing an otherwise-healthy run's detail view.
      console.warn(
        `[org-runs] audit unreadable for run "${runID}", degrading to []: ${e instanceof Error ? e.message : String(e)}`,
      )
      return []
    })
    const summary = OrgState.runSummary(run)
    const stages = Object.entries(run.stages).map(([stage, s]) => ({
      stage,
      status: s.status,
      deliverablePath:
        s.status === "completed" ? OrgArtifacts.deliverablePath(projectDir, run.runID, stage) : undefined,
      cost: OrgState.stageCost(s),
      attempts: s.attempts,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      decision: s.decision ?? null,
      criteria: s.criteria,
      objective: s.objective,
      iterations: s.iterations ?? 0,
      verdictHistory: s.verdictHistory,
      toolsUsed: s.toolsUsed,
    }))
    // organization.jsonc is supplementary for the detail view (same posture as approvals.json
    // above): a missing/corrupt org file degrades to an absent `budget` block rather than failing
    // an otherwise-healthy run's detail. Mirrors OrgStatusTool's budget assembly (organization/tools.ts).
    const spent = summary.totalCost
    const organization = await OrgSchema.loadOrganization(projectDir).catch((e: unknown) => {
      console.warn(
        `[org-runs] organization unreadable for run "${runID}", omitting budget: ${e instanceof Error ? e.message : String(e)}`,
      )
      return undefined
    })
    const budget = organization
      ? (() => {
          const org = organization
          const resolved = OrgSchema.resolveBudget(org)
          return {
            run: resolved.run,
            stage: resolved.stage,
            escalationThreshold: resolved.escalationThreshold,
            retries: resolved.retries,
            spent,
            remaining: Math.max(0, resolved.run - spent),
            escalated: run.escalated ?? false,
          }
        })()
      : undefined
    const loop = organization ? OrgSchema.resolveLoop(organization) : undefined
    return { run, audit, totalCost: summary.totalCost, stages, budget, loop }
  }
}

export const orgRunsHandlers = HttpApiBuilder.group(InstanceHttpApi, "org-runs", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const provider = yield* Provider.Service
    const workspace = (projectDir: string, organizationID?: string) =>
      organizationID
        ? Effect.promise(() => OrgWorkspace.resolve(projectDir, organizationID))
        : Effect.succeed(undefined)
    const scoped = <A>(ctx: OrgWorkspace.Context | undefined, fn: () => Promise<A>) =>
      ctx ? OrgWorkspace.run(ctx, fn) : fn()
    const organization = (projectDir: string, ctx?: OrgWorkspace.Context) =>
      Effect.tryPromise({
        try: () => scoped(ctx, () => OrgSchema.loadOrganization(projectDir)),
        catch: (error) => error,
      }).pipe(Effect.catch((error) => Effect.die(error)))

    const command = <A>(fn: () => Promise<A>) =>
      Effect.tryPromise({ try: fn, catch: (error) => error }).pipe(
        Effect.catchIf(
          (error: unknown): error is OrgState.NotFound => error instanceof OrgState.NotFound,
          () => Effect.fail(new HttpApiError.NotFound({})),
          (error) =>
            error instanceof OrgRunner.TransitionError
              ? Effect.fail(new HttpApiError.BadRequest({}))
              : Effect.die(error),
        ),
      )

    const response = (run: OrgState.Run) => ({ ok: true as const, runID: run.runID, status: run.status })

    const startDriver = (
      projectDir: string,
      ctx: OrgWorkspace.Context | undefined,
      org: OrgSchema.Organization,
      run: OrgState.Run,
    ) => {
      if (run.status !== "active" || run.auto !== true || !run.ownerSessionID) return
      const runtime = OrgDriver.sessionRuntime({
        ownerSessionID: run.ownerSessionID,
        bridge: effectSessionBridge({ sessions, prompts, provider }),
      })
      void OrgDriver.attach({
        projectDir,
        organization: ctx,
        org,
        runID: run.runID,
        runtime,
        lock: (fn) => withRunLock(run.runID, fn),
      }).catch((error) =>
        console.warn(
          `[org-runs] autonomous driver failed for "${run.runID}": ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }

    const list = Effect.fn("OrgRunsHttpApi.list")(function* (ctx: { query: typeof OrgRunQuery.Type }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => OrgRunsView.list(instance.directory, ctx.query.organizationID))
    })

    const detail = Effect.fn("OrgRunsHttpApi.detail")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
    }) {
      const instance = yield* InstanceState.context
      // OrgState.NotFound (unknown runID / traversal) is a normal, expected outcome -> mapped to
      // the declared 404 failure below. Anything else means the run exists but its state.json (or
      // the promise chain around it) is corrupt/unreadable -- that must NOT be reported as "not
      // found" (Wave 3 observability review, Minor #5), so the `orElse` branch of catchIf re-raises
      // it as a defect via Effect.die: the declared error channel only carries
      // HttpApiError.NotFound, and the house errorLayer maps an unhandled defect to a generic 500
      // with no path/message leak.
      return yield* Effect.tryPromise({
        try: () => OrgRunsView.detail(instance.directory, ctx.params.runID, ctx.query.organizationID),
        catch: (e) => e, // keep the raw error on the failure channel (typed `unknown`) for catchIf below
      }).pipe(
        Effect.catchIf(
          (e: unknown): e is OrgState.NotFound => e instanceof OrgState.NotFound,
          () => Effect.fail(new HttpApiError.NotFound({})),
          (e) => Effect.die(e),
        ),
      )
    })

    const plan = Effect.fn("OrgRunsHttpApi.plan")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
      payload: typeof OrgRunPlanPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const orgctx = yield* workspace(instance.directory, ctx.query.organizationID)
      const org = yield* organization(instance.directory, orgctx)
      const run = yield* command(() =>
        scoped(orgctx, () =>
          withRunLock(ctx.params.runID, () =>
            OrgRunner.commitPlan(instance.directory, org, ctx.params.runID, ctx.payload.stages),
          ),
        ),
      )
      startDriver(instance.directory, orgctx, org, run)
      return response(run)
    })

    const decision = Effect.fn("OrgRunsHttpApi.decision")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
      payload: typeof OrgRunDecisionPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const orgctx = yield* workspace(instance.directory, ctx.query.organizationID)
      const org = yield* organization(instance.directory, orgctx)
      const run = yield* command(() =>
        scoped(orgctx, () =>
          withRunLock(ctx.params.runID, () =>
            OrgRunner.decide(
              instance.directory,
              org,
              ctx.params.runID,
              ctx.payload.decision,
              ctx.payload.note,
              ctx.payload.stage,
            ),
          ),
        ),
      )
      startDriver(instance.directory, orgctx, org, run)
      return response(run)
    })

    const note = Effect.fn("OrgRunsHttpApi.note")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
      payload: typeof OrgRunNotePayload.Type
    }) {
      const instance = yield* InstanceState.context
      const orgctx = yield* workspace(instance.directory, ctx.query.organizationID)
      const org = yield* organization(instance.directory, orgctx)
      const run = yield* command(() =>
        scoped(orgctx, () =>
          withRunLock(ctx.params.runID, () =>
            OrgNote.append(instance.directory, org, ctx.params.runID, {
              target: ctx.payload.target_agent,
              text: ctx.payload.text,
              from: "mission-control",
            }),
          ),
        ),
      )
      return response(run)
    })

    const stop = Effect.fn("OrgRunsHttpApi.stop")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
      payload: typeof OrgRunStopPayload.Type
    }) {
      const instance = yield* InstanceState.context
      const orgctx = yield* workspace(instance.directory, ctx.query.organizationID)
      const org = yield* organization(instance.directory, orgctx)
      const stopped = yield* command(() =>
        scoped(orgctx, () =>
          withRunLock(ctx.params.runID, () =>
            OrgRunner.stop(instance.directory, org, ctx.params.runID, ctx.payload.reason),
          ),
        ),
      )
      return response(stopped.run)
    })

    const pause = Effect.fn("OrgRunsHttpApi.pause")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
      payload: typeof OrgRunPausePayload.Type
    }) {
      const instance = yield* InstanceState.context
      const orgctx = yield* workspace(instance.directory, ctx.query.organizationID)
      const org = yield* organization(instance.directory, orgctx)
      const run = yield* command(() =>
        scoped(orgctx, () =>
          withRunLock(ctx.params.runID, async () => {
            const current = await OrgState.read(instance.directory, ctx.params.runID)
            const stage = ctx.payload.stage ?? OrgState.runSummary(current).currentStage ?? "none"
            return OrgRunner.pause(instance.directory, org, ctx.params.runID, {
              kind: "manual",
              stage,
              detail: ctx.payload.detail,
            })
          }),
        ),
      )
      return response(run)
    })

    const resume = Effect.fn("OrgRunsHttpApi.resume")(function* (ctx: {
      params: { runID: string }
      query: typeof OrgRunQuery.Type
      payload: typeof OrgRunResumePayload.Type
    }) {
      const instance = yield* InstanceState.context
      const orgctx = yield* workspace(instance.directory, ctx.query.organizationID)
      const org = yield* organization(instance.directory, orgctx)
      const run = yield* command(() =>
        scoped(orgctx, () =>
          withRunLock(ctx.params.runID, () =>
            OrgRunner.resume(instance.directory, org, ctx.params.runID, ctx.payload.note),
          ),
        ),
      )
      startDriver(instance.directory, orgctx, org, run)
      return response(run)
    })

    return handlers
      .handle("list", list)
      .handle("detail", detail)
      .handle("plan", plan)
      .handle("decision", decision)
      .handle("note", note)
      .handle("stop", stop)
      .handle("pause", pause)
      .handle("resume", resume)
  }),
)
