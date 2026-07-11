// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { guardCeo, load, tryOrg } from "@/kilocode/organization/tools"
// kilocode_change - W6.3 fix: KiloIndexing (indexing.ts) and OrgRag (rag.ts) are imported LAZILY
// inside execute() rather than at module top-level. A static import of the heavy KiloIndexing module
// here pulls it into the registry's module-init graph (registry.ts imports this tool), perturbing
// module load order enough to trip a latent circular-import TDZ in control-plane/workspace.ts across
// the whole suite. Deferring to call-time keeps this tool's static footprint minimal. Types are erased.
import type { OrgRag as OrgRagNs } from "@/kilocode/organization/rag"

import DESCRIPTION from "./org-search.txt"

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Natural-language search query over the organization's run deliverables.",
  }),
  run_id: Schema.optional(Schema.String).annotate({
    description: "Optional run id to scope the search to a single run's deliverables.",
  }),
  dept: Schema.optional(Schema.String).annotate({
    description: "Optional department/stage tag to narrow results (e.g. 'eng', 'evaluation').",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matches to return.",
  }),
})

type Meta = {
  results: OrgRagNs.SearchHit[]
}

export const OrgSearchTool = Tool.define(
  "org_search",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ): Effect.Effect<Tool.ExecuteResult<Meta>> =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const dir = instance.directory
        const org = yield* load(dir)
        yield* guardCeo(org, ctx.agent)

        // kilocode_change - W6.3 fix: lazy-load the heavy indexing modules at call-time (see the
        // top-of-file note on the module-init cycle). These awaits happen only when the tool runs.
        const { KiloIndexing } = yield* Effect.promise(() => import("@/kilocode/indexing"))
        const { OrgRag } = yield* Effect.promise(() => import("@/kilocode/organization/rag"))

        // kilocode_change - W6.3: resolve a real embedder/store from KiloIndexing (production);
        // orgRagServices NEVER throws (it catches internally and returns undefined), so this is a
        // plain promise, not tryOrg. A missing services pair is passed straight through to
        // OrgRag.search, which is itself guaranteed to degrade to {unavailable: true} rather than
        // throw on a missing/failing embedder - so this tool can never surface a raw error for
        // "no embedder configured", only the clean unavailable message below.
        const services = yield* Effect.promise(() => KiloIndexing.orgRagServices(dir))
        const searched = yield* tryOrg(() =>
          OrgRag.search(
            dir,
            params.query,
            { runID: params.run_id, dept: params.dept, limit: params.limit },
            services?.embedder,
            services?.store,
          ),
        )

        if (searched.unavailable) {
          const reason = searched.reason ?? "no embedder configured"
          return {
            title: "Org Deliverable Search",
            metadata: { results: [] },
            output: `org search unavailable: ${reason} (configure an embedder)`,
          }
        }

        const results = searched.results
        const scope = [
          params.run_id ? `run ${params.run_id}` : undefined,
          params.dept ? `dept "${params.dept}"` : undefined,
        ]
          .filter((v): v is string => Boolean(v))
          .join(", ")

        if (results.length === 0) {
          return {
            title: "Org Deliverable Search",
            metadata: { results },
            output: `No relevant deliverables found for "${params.query}"${scope ? ` (${scope})` : ""}.`,
          }
        }

        const output = [
          `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${params.query}"${scope ? ` (${scope})` : ""}.`,
          "",
          ...results.flatMap((hit, index) => {
            return [
              `${index + 1}. ${hit.filePath}:${hit.startLine}-${hit.endLine} (score ${hit.score.toFixed(4)})`,
              `cite: ${hit.filePath}:${hit.startLine} (run ${hit.runID})`,
              hit.codeChunk,
              "",
            ]
          }),
        ]

        return {
          title: "Org Deliverable Search",
          metadata: { results },
          output: output.join("\n").trim(),
        }
      }).pipe(Effect.orDie),
  }),
)
