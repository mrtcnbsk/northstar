// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { Agent } from "@/agent/agent"
import { guardCeo, load, result } from "@/kilocode/organization/tools"
import { OrgMetrics } from "@/kilocode/organization/metrics"
import { OrgRouting } from "@/kilocode/organization/routing"

import DESCRIPTION from "./org-route.txt"

const Parameters = Schema.Struct({
  stage: Schema.optional(Schema.String).annotate({
    description:
      "Department/stage name to rank that department's workers. Omitted: ranks the org chart's department chiefs (deduplicated) instead.",
  }),
  capabilities: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Capability tags the task needs, matched against each candidate's configured capabilities.",
  }),
  type: Schema.optional(Schema.String).annotate({
    description: "App/task type, matched against each candidate's configured preferredTypes for a bonus.",
  }),
})

/** Human-readable one-line-per-candidate summary, best-first. Mirrors the "N. agent (score X) -
 * reasons" shape so the CEO can read the ranking without parsing the JSON `ranked` array. */
function summarize(ranked: OrgRouting.Ranked[]): string {
  return ranked
    .map((r, i) => `${i + 1}. ${r.agent} — score ${r.score.toFixed(2)} (match ${r.matchScore.toFixed(2)}): ${r.reasons.join("; ")}`)
    .join("\n")
}

export const RouteTaskTool = Tool.define(
  "org_route",
  Effect.gen(function* () {
    // Captured here (inside Tool.define's own resolution, where Agent.Service is already
    // provided) rather than re-`yield*`ed inside execute() - execute()'s returned Effect has NO
    // requirement channel (see Tool.Def.execute's signature), so a service must be resolved to a
    // plain Interface value up here and closed over, exactly like org_status captures `config`.
    const agents = yield* Agent.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = instance.directory
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)

          // Roster: Agent.Service.list() carries the MERGED runtime Info (markdown + config-inline
          // agent definitions), including capabilities/preferredTypes - unlike cfg.agent, which is
          // only the config-inline slice.
          const infos = yield* agents.list()
          const infoByName = new Map(infos.map((info) => [info.name, info]))

          // Best-effort health: OrgMetrics.collect is async and never throws by contract, but this
          // call site can't assume that of every future change to it - degrade to an empty roster
          // (every candidate scored via rank()'s neutral prior) rather than fail routing over a
          // metrics hiccup.
          const metrics = yield* Effect.tryPromise(() => OrgMetrics.collect(dir)).pipe(
            Effect.orElseSucceed((): OrgMetrics.AgentMetrics[] => []),
          )
          const healthByAgent = new Map(metrics.map((m) => [m.agent, OrgMetrics.health(m)]))

          const names: string[] = params.stage
            ? (org.departments[params.stage]?.workers ?? [])
            : [...new Set(Object.values(org.departments).map((d) => d.chief))]

          const candidates: OrgRouting.Candidate[] = names.map((name) => {
            const info = infoByName.get(name)
            return { agent: name, capabilities: info?.capabilities, preferredTypes: info?.preferredTypes }
          })

          const ranked = OrgRouting.rank(
            { capabilities: params.capabilities, type: params.type },
            candidates,
            healthByAgent,
          )

          if (ranked.length === 0) {
            const scope = params.stage
              ? `stage "${params.stage}" has no workers`
              : "the org chart has no departments"
            return result(`org_route: no candidates (${scope})`, {
              stage: params.stage ?? null,
              ranked: [],
            })
          }

          return result(`org_route: "${ranked[0]!.agent}" ranked first`, {
            stage: params.stage ?? null,
            ranked,
            summary: summarize(ranked),
          })
        }).pipe(Effect.orDie),
    }
  }),
)
