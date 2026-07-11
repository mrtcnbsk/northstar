// kilocode_change - new file
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { OrgMetrics } from "@/kilocode/organization/metrics"
import type { AgentMetricsResponse } from "../groups/agents"

/**
 * Pure, org-free view builder over OrgMetrics.collect/health. Kept separate from the Effect
 * handler wiring so it can be unit-tested directly with tmpdir fixtures (see test/kilocode/server).
 * Per-run isolation (skip-on-corrupt) already lives inside OrgMetrics.collect -- this layer must
 * not re-introduce a throw for an individual bad run, only surface genuine collection failures
 * (e.g. the runs directory itself being unreadable).
 */
export namespace AgentsView {
  export async function list(projectDir: string): Promise<typeof AgentMetricsResponse.Type> {
    const metrics = await OrgMetrics.collect(projectDir)
    return {
      agents: metrics.map((m) => {
        const h = OrgMetrics.health(m)
        return {
          agent: m.agent,
          runs: m.runs,
          stages: m.stages,
          totalCost: m.totalCost,
          avgCostPerStage: m.avgCostPerStage,
          completed: m.completed,
          failed: m.failed,
          blocked: m.blocked,
          successRate: m.successRate,
          avgLatencyMs: m.avgLatencyMs,
          health: { score: h.score, band: h.band },
        }
      }),
    }
  }
}

export const agentsHandlers = HttpApiBuilder.group(InstanceHttpApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const list = Effect.fn("AgentsHttpApi.list")(function* () {
      const instance = yield* InstanceState.context
      // Any failure here (the runs directory itself being unreadable, etc.) is a genuine defect,
      // not an expected outcome -- there is no declared error channel on this endpoint (no 404;
      // a list is never "not found"), so it surfaces as an unhandled defect and the house
      // errorLayer maps it to a generic 500 with no path/message leak (Wave 3 org-runs pattern).
      return yield* Effect.promise(() => AgentsView.list(instance.directory))
    })

    return handlers.handle("list", list)
  }),
)
