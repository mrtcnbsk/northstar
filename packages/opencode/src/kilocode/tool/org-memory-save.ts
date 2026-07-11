// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { guardCeo, load, result, tryOrg } from "@/kilocode/organization/tools"
import { OrgMemory } from "@/kilocode/organization/memory"

import DESCRIPTION from "./org-memory-save.txt"

const Parameters = Schema.Struct({
  text: Schema.String.annotate({
    description: "The lesson/fact text to save to the org-shared memory pool. Keep it concise and durable.",
  }),
  dept: Schema.optional(Schema.String).annotate({
    description: "Optional department tag (e.g. 'eng', 'design') so org_recall can later filter to this dept.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "Optional stable key for this entry; a key is derived from the text when omitted.",
  }),
})

export const OrgMemorySaveTool = Tool.define(
  "org_memory_save",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const dir = instance.directory
        const org = yield* load(dir)
        yield* guardCeo(org, ctx.agent)
        const saved = yield* tryOrg(() =>
          OrgMemory.save(dir, { text: params.text, dept: params.dept, key: params.key }),
        )
        return result(`org memory saved`, {
          ok: saved.ok,
          ...(params.dept ? { dept: params.dept } : {}),
          ...(saved.detail
            ? { message: saved.detail.message, operationCount: saved.detail.operationCount }
            : { message: "memory operation produced no change" }),
        })
      }).pipe(Effect.orDie),
  }),
)
