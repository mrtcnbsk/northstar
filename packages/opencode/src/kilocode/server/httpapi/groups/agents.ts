// kilocode_change - new file
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Read-only view schema over the per-chief metrics rollup (OrgMetrics.collect + OrgMetrics.health,
// see W8.2). Kept independent of the zod OrgState/OrgSchema-derived OrgMetrics.AgentMetrics type so
// the API surface is decoupled from internal storage details -- literals are redefined here rather
// than exported from metrics.ts, mirroring org-runs.ts's StageStatus.

const HealthBand = Schema.Literals(["healthy", "degraded", "unhealthy"])

const AgentHealthView = Schema.Struct({
  score: Schema.Number,
  band: HealthBand,
}).annotate({ identifier: "AgentHealthView" })

const AgentMetricsRow = Schema.Struct({
  agent: Schema.String,
  runs: Schema.Number,
  stages: Schema.Number,
  totalCost: Schema.Number,
  avgCostPerStage: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  blocked: Schema.Number,
  successRate: Schema.Number,
  // kilocode_change - CODEGEN GAP (investigated, not fixed here): avgLatencyMs is always a finite
  // computed average or null (see OrgMetrics.aggregate), never NaN/Infinity, so ideally this would
  // be `Schema.NullOr(Schema.Finite)` and the generated SDK type would read `number | null`. In
  // ISOLATION that combinator does codegen cleanly (verified directly against OpenApi.fromApi with
  // just this endpoint's HttpApi) - but assembled into the FULL PublicApi (every group's endpoints
  // merged together, all sharing the same top-level `Schema.Number`/`Schema.Finite`/`Schema.String`
  // singletons), the `| null` branch gets silently dropped from the generated OpenAPI JSON schema
  // for THIS field, and the same happens for an unrelated pre-existing REQUIRED `Schema.NullOr`
  // field elsewhere (org-runs.ts's `currentStage`) - so this is an upstream schema-merging/caching
  // interaction in Effect's OpenApi/JSON-Schema generation across a large multi-group HttpApi, not
  // something this call site's schema choice controls. Fixing it for real needs Effect-Schema
  // surgery out of scope here; kept as `Schema.NullOr(Schema.Number)` and the console
  // (agents-view.ts) keeps its defensive `| null | undefined` re-widening of the SDK type.
  avgLatencyMs: Schema.NullOr(Schema.Number),
  health: AgentHealthView,
}).annotate({ identifier: "AgentMetricsRow" })

export const AgentMetricsResponse = Schema.Struct({
  agents: Schema.Array(AgentMetricsRow),
}).annotate({ identifier: "AgentMetricsResponse" })

export const AgentsPaths = {
  list: "/agents",
} as const

export const AgentsApi = HttpApi.make("agents")
  .add(
    HttpApiGroup.make("agents")
      .add(
        HttpApiEndpoint.get("list", AgentsPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(AgentMetricsResponse, "Per-chief metrics rollup with health score/band"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "agents.list",
            summary: "List agent metrics",
            description:
              "Summarize every chief's cross-run metrics for the active workspace (summed cost, stage/outcome counts, success rate, avg latency) together with a threshold-driven health score and band.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({ title: "agents", description: "Read-only agent registry metrics routes." }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Northstar HttpApi surface.",
    }),
  )
