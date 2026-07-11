// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { guardCeo, load, result, tryOrg } from "@/kilocode/organization/tools"
import { OrgMemory } from "@/kilocode/organization/memory"

import DESCRIPTION from "./org-recall.txt"

const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Topic query to search the org-shared memory pool for.",
  }),
  dept: Schema.optional(Schema.String).annotate({
    description: "Optional department tag to narrow results to entries saved under that dept.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matches to return.",
  }),
})

export const OrgRecallTool = Tool.define(
  "org_recall",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const dir = instance.directory
        const org = yield* load(dir)
        yield* guardCeo(org, ctx.agent)
        const recalled = yield* tryOrg(() =>
          OrgMemory.recall(dir, { query: params.query, dept: params.dept, limit: params.limit }),
        )
        if (recalled.hits.length === 0) {
          return result(`org memory: no results`, {
            count: 0,
            hits: [],
            ...(params.dept ? { dept: params.dept } : {}),
          })
        }
        return result(`org memory: ${recalled.hits.length} hit${recalled.hits.length === 1 ? "" : "s"}`, {
          count: recalled.hits.length,
          hits: recalled.hits.map((hit) => ({ text: hit.text, source: hit.source, score: hit.score })),
          files: recalled.files,
          ...(params.dept ? { dept: params.dept } : {}),
        })
      }).pipe(Effect.orDie),
  }),
)
