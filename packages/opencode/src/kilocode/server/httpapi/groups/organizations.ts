// kilocode_change - Northstar project-local organization management API
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const OrganizationEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  layout: Schema.Literals(["legacy", "managed"]),
  root: Schema.String,
}).annotate({ identifier: "NorthstarOrganizationEntry" })

const OrganizationView = Schema.Struct({
  ...OrganizationEntry.fields,
  valid: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  draft: Schema.Boolean,
}).annotate({ identifier: "NorthstarOrganizationView" })

export const OrganizationsResponse = Schema.Struct({
  version: Schema.Literal(1),
  active: Schema.optional(Schema.String),
  organizations: Schema.Array(OrganizationView),
  drafts: Schema.Array(OrganizationView),
}).annotate({ identifier: "NorthstarOrganizationsResponse" })

export const OrganizationStageInput = Schema.Struct({ name: Schema.String })
export const OrganizationStageResponse = Schema.Struct({ organization: OrganizationEntry }).annotate({
  identifier: "NorthstarOrganizationStageResponse",
})

const AgentFile = Schema.Struct({ id: Schema.String, content: Schema.String })
export const OrganizationSaveInput = Schema.Struct({
  draft: Schema.Unknown,
  organization: Schema.String,
  agents: Schema.Array(AgentFile),
})
export const OrganizationUpdateInput = Schema.Struct({
  name: Schema.String,
  ...OrganizationSaveInput.fields,
})
export const OrganizationGetResponse = Schema.Struct({
  organization: OrganizationEntry,
  valid: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  draft: Schema.optional(Schema.Unknown),
  definition: Schema.optional(Schema.String),
  agents: Schema.Array(AgentFile),
}).annotate({ identifier: "NorthstarOrganizationGetResponse" })

export const OrganizationKnowledgeScope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({ type: Schema.Literal("department"), departmentID: Schema.String }),
])
export const OrganizationKnowledgeImportInput = Schema.Struct({
  sources: Schema.Array(Schema.String),
  scope: OrganizationKnowledgeScope,
})
const OrganizationKnowledgeItem = Schema.Struct({
  id: Schema.String,
  source: Schema.String,
  managed: Schema.String,
  scope: OrganizationKnowledgeScope,
  hash: Schema.String,
  size: Schema.Number,
  importedAt: Schema.String,
})
export const OrganizationKnowledgeImportResponse = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ source: Schema.String, status: Schema.Literals(["indexed", "unchanged"]), item: OrganizationKnowledgeItem }),
  ),
}).annotate({ identifier: "NorthstarOrganizationKnowledgeImportResponse" })

export const OrganizationKnowledgeSearchInput = Schema.Struct({
  query: Schema.String,
  departmentID: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})
export const OrganizationKnowledgeSearchResponse = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    managed: Schema.String,
    scope: OrganizationKnowledgeScope,
    tokens: Schema.Array(Schema.String),
    excerpt: Schema.String,
    score: Schema.Number,
  }),
).annotate({ identifier: "NorthstarOrganizationKnowledgeSearchResponse" })

export const OrganizationsPaths = {
  list: "/organizations",
  get: "/organizations/:organizationID",
  stage: "/organizations/staging",
  saveDraft: "/organizations/staging/:organizationID",
  discardDraft: "/organizations/staging/:organizationID",
  update: "/organizations/:organizationID",
  select: "/organizations/:organizationID/select",
  publish: "/organizations/:organizationID/publish",
  importKnowledge: "/organizations/:organizationID/knowledge/import",
  searchKnowledge: "/organizations/:organizationID/knowledge/search",
} as const

const params = { organizationID: Schema.String }
const badRequest = HttpApiError.BadRequest

export const OrganizationsApi = HttpApi.make("organizations")
  .add(
    HttpApiGroup.make("organizations")
      .add(
        HttpApiEndpoint.get("list", OrganizationsPaths.list, {
          query: WorkspaceRoutingQuery,
          success: described(OrganizationsResponse, "Project-local Northstar organizations"),
          error: badRequest,
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.list", summary: "List organizations" })),
        HttpApiEndpoint.get("get", OrganizationsPaths.get, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(OrganizationGetResponse, "Organization Setup definition"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.get", summary: "Get organization" })),
        HttpApiEndpoint.put("update", OrganizationsPaths.update, {
          params,
          query: WorkspaceRoutingQuery,
          payload: OrganizationUpdateInput,
          success: described(OrganizationGetResponse, "Updated organization definition"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.update", summary: "Update organization" })),
        HttpApiEndpoint.post("stage", OrganizationsPaths.stage, {
          query: WorkspaceRoutingQuery,
          payload: OrganizationStageInput,
          success: described(OrganizationStageResponse, "Staged organization draft"),
          error: badRequest,
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.stage", summary: "Stage organization" })),
        HttpApiEndpoint.put("saveDraft", OrganizationsPaths.saveDraft, {
          params,
          query: WorkspaceRoutingQuery,
          payload: OrganizationSaveInput,
          success: described(OrganizationGetResponse, "Saved organization draft"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.saveDraft", summary: "Save organization draft" })),
        HttpApiEndpoint.delete("discardDraft", OrganizationsPaths.discardDraft, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(OrganizationsResponse, "Organizations after draft discard"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.discardDraft", summary: "Discard organization draft" })),
        HttpApiEndpoint.post("select", OrganizationsPaths.select, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(OrganizationsResponse, "Organizations after selection"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.select", summary: "Select organization" })),
        HttpApiEndpoint.post("publish", OrganizationsPaths.publish, {
          params,
          query: WorkspaceRoutingQuery,
          success: described(OrganizationsResponse, "Organizations after publication"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.publish", summary: "Publish organization" })),
        HttpApiEndpoint.post("importKnowledge", OrganizationsPaths.importKnowledge, {
          params,
          query: WorkspaceRoutingQuery,
          payload: OrganizationKnowledgeImportInput,
          success: described(OrganizationKnowledgeImportResponse, "Managed knowledge import result"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.importKnowledge", summary: "Import organization knowledge" })),
        HttpApiEndpoint.post("searchKnowledge", OrganizationsPaths.searchKnowledge, {
          params,
          query: WorkspaceRoutingQuery,
          payload: OrganizationKnowledgeSearchInput,
          success: described(OrganizationKnowledgeSearchResponse, "Scoped local knowledge search results"),
          error: [HttpApiError.NotFound, badRequest],
        }).annotateMerge(OpenApi.annotations({ identifier: "organizations.searchKnowledge", summary: "Search organization knowledge" })),
      )
      .annotateMerge(OpenApi.annotations({ title: "organizations", description: "Northstar project organization routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(OpenApi.annotations({ title: "Northstar HttpApi", version: "0.0.1" }))
