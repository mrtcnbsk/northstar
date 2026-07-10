// kilocode_change - new file
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

// Read-only view schemas over org RUN state (state.json + approvals.json). Kept independent of the
// zod OrgState/OrgAudit schemas so the API surface is decoupled from internal storage details.

const OrgRunStatus = Schema.Literals(["active", "halted", "completed"])
const StageStatus = Schema.Literals(["pending", "running", "awaiting_approval", "completed", "skipped", "failed"])

const OrgRunSummary = Schema.Struct({
  runID: Schema.String,
  idea: Schema.String,
  status: OrgRunStatus,
  createdAt: Schema.String,
  totalCost: Schema.Number,
  stageCount: Schema.Number,
  currentStage: Schema.NullOr(Schema.String),
  awaitingGate: Schema.Boolean,
}).annotate({ identifier: "OrgRunSummary" })

export const OrgRunsListResponse = Schema.Struct({
  runs: Schema.Array(OrgRunSummary),
}).annotate({ identifier: "OrgRunsListResponse" })

const OrgRunStage = Schema.Struct({
  status: StageStatus,
  taskID: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  costTaskID: Schema.optional(Schema.String),
  costs: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  attempts: Schema.Number,
  incompleteAttempts: Schema.optional(Schema.Number),
  decision: Schema.optional(Schema.Literals(["approve", "no-go", "revise"])),
  decisionNote: Schema.optional(Schema.String),
  reviseBaseline: Schema.optional(Schema.String),
  reviseNote: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
}).annotate({ identifier: "OrgRunStage" })

const OrgRunFull = Schema.Struct({
  runID: Schema.String,
  idea: Schema.String,
  createdAt: Schema.String,
  status: OrgRunStatus,
  haltReason: Schema.optional(Schema.String),
  stages: Schema.Record(Schema.String, OrgRunStage),
  escalated: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OrgRunFull" })

const OrgAuditEntry = Schema.Struct({
  ts: Schema.String,
  stage: Schema.String,
  decision: Schema.String,
  note: Schema.optional(Schema.String),
  deliverableHash: Schema.optional(Schema.String),
}).annotate({ identifier: "OrgAuditEntry" })

const OrgRunStageView = Schema.Struct({
  stage: Schema.String,
  status: StageStatus,
  cost: Schema.Number,
  attempts: Schema.Number,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.Literals(["approve", "no-go", "revise"])),
}).annotate({ identifier: "OrgRunStageView" })

export const OrgRunDetailResponse = Schema.Struct({
  run: OrgRunFull,
  audit: Schema.Array(OrgAuditEntry),
  totalCost: Schema.Number,
  stages: Schema.Array(OrgRunStageView),
}).annotate({ identifier: "OrgRunDetailResponse" })

export const OrgRunsPaths = {
  list: "/org-runs",
  detail: "/org-runs/:runID",
} as const

export const OrgRunsApi = HttpApi.make("org-runs")
  .add(
    HttpApiGroup.make("org-runs")
      .add(
        HttpApiEndpoint.get("list", OrgRunsPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(OrgRunsListResponse, "Org runs summary list"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "orgRuns.list",
            summary: "List org runs",
            description:
              "Summarize every org run for the active workspace (status, total cost, current stage, gate state), newest first.",
          }),
        ),
        HttpApiEndpoint.get("detail", OrgRunsPaths.detail, {
          params: { runID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(OrgRunDetailResponse, "Full org run state, audit trail, and per-stage view"),
          error: HttpApiError.NotFound,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "orgRuns.detail",
            summary: "Get org run detail",
            description: "Return the full run state, gate-decision audit trail, total cost, and a per-stage view.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "org-runs", description: "Read-only org run observability routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
