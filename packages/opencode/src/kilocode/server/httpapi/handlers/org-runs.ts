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
export namespace OrgRunsView {
  export async function list(projectDir: string): Promise<typeof OrgRunsListResponse.Type> {
    const ids = await OrgState.list(projectDir) // already reverse-sorted (newest first); [] when no runs dir
    const runs = await Promise.all(
      ids.map(async (runID) => {
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
      }),
    )
    return { runs }
  }

  /** Throws a readable Error (message contains the runID) when the run does not exist. */
  export async function detail(projectDir: string, runID: string): Promise<typeof OrgRunDetailResponse.Type> {
    const run = await OrgState.read(projectDir, runID) // throws "Unknown org run ..." on ENOENT
    const audit = await OrgAudit.read(projectDir, runID) // [] when approvals.json absent
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
      return yield* Effect.tryPromise({
        try: () => OrgRunsView.detail(instance.directory, ctx.params.runID),
        // OrgState.read throws a readable Error on an unknown runID -> map to a 404.
        catch: () => new HttpApiError.NotFound(),
      })
    })

    return handlers.handle("list", list).handle("detail", detail)
  }),
)
