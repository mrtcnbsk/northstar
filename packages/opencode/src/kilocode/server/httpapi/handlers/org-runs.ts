// kilocode_change - new file
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { OrgState } from "@/kilocode/organization/state"
import { OrgAudit } from "@/kilocode/organization/audit"
import type { OrgRunDetailResponse, OrgRunsListResponse } from "../groups/org-runs"

/**
 * Pure, org-free view builders over run state.json + approvals.json. Kept separate from the Effect
 * handler wiring so they can be unit-tested directly with tmpdir fixtures (see test/kilocode/server).
 * Cost math is delegated to OrgState.runSummary/stageCost — never re-derived here.
 */
type RunSummaryEntry = typeof OrgRunsListResponse.Type["runs"][number]

export namespace OrgRunsView {
  /**
   * Each run is read in isolation: a single corrupt/unreadable/schema-invalid state.json (or a
   * stray subdirectory with no state.json at all) must not take down the whole list. On any
   * per-run failure we log a warning with the offending runID + reason and skip that run --
   * healthy runs still render. See Wave 3 observability review (Bug A).
   */
  export async function list(projectDir: string): Promise<typeof OrgRunsListResponse.Type> {
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
  export async function detail(projectDir: string, runID: string): Promise<typeof OrgRunDetailResponse.Type> {
    const run = await OrgState.read(projectDir, runID) // throws OrgState.NotFound on ENOENT/traversal
    const audit = await OrgAudit.read(projectDir, runID).catch((e: unknown) => {
      // approvals.json is supplementary: a corrupt/unreadable audit trail degrades to an empty
      // list rather than failing an otherwise-healthy run's detail view.
      console.warn(`[org-runs] audit unreadable for run "${runID}", degrading to []: ${e instanceof Error ? e.message : String(e)}`)
      return []
    })
    const summary = OrgState.runSummary(run)
    const stages = Object.entries(run.stages).map(([stage, s]) => ({
      stage,
      status: s.status,
      cost: OrgState.stageCost(s),
      attempts: s.attempts,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      decision: s.decision ?? null,
    }))
    return { run, audit, totalCost: summary.totalCost, stages }
  }
}

export const orgRunsHandlers = HttpApiBuilder.group(InstanceHttpApi, "org-runs", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("OrgRunsHttpApi.list")(function* () {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => OrgRunsView.list(instance.directory))
    })

    const detail = Effect.fn("OrgRunsHttpApi.detail")(function* (ctx: { params: { runID: string } }) {
      const instance = yield* InstanceState.context
      // OrgState.NotFound (unknown runID / traversal) is a normal, expected outcome -> mapped to
      // the declared 404 failure below. Anything else means the run exists but its state.json (or
      // the promise chain around it) is corrupt/unreadable -- that must NOT be reported as "not
      // found" (Wave 3 observability review, Minor #5), so the `orElse` branch of catchIf re-raises
      // it as a defect via Effect.die: the declared error channel only carries
      // HttpApiError.NotFound, and the house errorLayer maps an unhandled defect to a generic 500
      // with no path/message leak.
      return yield* Effect.tryPromise({
        try: () => OrgRunsView.detail(instance.directory, ctx.params.runID),
        catch: (e) => e, // keep the raw error on the failure channel (typed `unknown`) for catchIf below
      }).pipe(
        Effect.catchIf(
          (e: unknown): e is OrgState.NotFound => e instanceof OrgState.NotFound,
          () => Effect.fail(new HttpApiError.NotFound({})),
          (e) => Effect.die(e),
        ),
      )
    })

    return handlers.handle("list", list).handle("detail", detail)
  }),
)
