// kilocode_change - new file
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const OrgBuilderSaveInput = Schema.Struct({
  /** Serialized JSONC text, e.g. `OrgSchema.serialize(draft)` — mirrors organization.jsonc's own
   * on-disk shape so the handler can run the exact same parseJsonc -> OrgSchema.parse pipeline
   * `OrgSchema.loadOrganization` uses, instead of trusting a pre-parsed client-side object. */
  organization: Schema.String,
})

export const OrgBuilderSaveOutput = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(Schema.String),
  path: Schema.optional(Schema.String),
}).annotate({ identifier: "OrgBuilderSaveOutput" })

export const OrgBuilderPaths = {
  save: "/org-builder",
} as const

export const OrgBuilderApi = HttpApi.make("org-builder")
  .add(
    HttpApiGroup.make("org-builder")
      .add(
        HttpApiEndpoint.put("save", OrgBuilderPaths.save, {
          query: WorkspaceRoutingQuery,
          payload: OrgBuilderSaveInput,
          success: described(OrgBuilderSaveOutput, "Fail-closed organization.jsonc write result"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "orgBuilder.save",
            summary: "Save organization.jsonc",
            description:
              "Validate a serialized organization (JSONC syntax + structural validate + agent cross-check) and write it to .kilo/organization.jsonc only when clean — fails closed (no write) otherwise.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "org-builder", description: "Kilo organization builder routes." }))
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
