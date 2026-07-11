// kilocode_change - new file
// W9.2: tool-level coverage for org_route. Mirrors org-memory-tools.test.ts's ManagedRuntime
// harness (the smallest seam that runs a real Tool.execute()), plus OrgState.create/update to
// fabricate the run history org_route's health lookup (OrgMetrics.collect) reads off disk.
import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { RouteTaskTool } from "../../../src/kilocode/tool/org-route"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Plugin } from "../../../src/plugin"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    eng: { chief: "chief-eng", workers: ["worker-eng"] },
    mkt: { chief: "chief-mkt", workers: ["worker-mkt"] },
  },
  pipeline: [{ stage: "eng" }, { stage: "mkt" }],
})

// Config-inline agent definitions (opencode.json's `agent` field): chief-eng is tagged with the
// capabilities the fixture's task need asks for; chief-mkt is tagged with disjoint capabilities,
// so its capability match score is 0 regardless of health.
const AGENT_CONFIG = {
  ceo: { mode: "primary" as const },
  "chief-eng": { mode: "subagent" as const, capabilities: ["swift", "ios"], preferredTypes: ["utility"] },
  "worker-eng": { mode: "subagent" as const, capabilities: ["swift"] },
  "chief-mkt": { mode: "subagent" as const, capabilities: ["marketing", "copy"], preferredTypes: ["fintech"] },
  "worker-mkt": { mode: "subagent" as const, capabilities: ["copy"] },
}

function makeRuntime() {
  return ManagedRuntime.make(
    Layer.mergeAll(
      CrossSpawnSpawner.defaultLayer,
      AppFileSystem.defaultLayer,
      Plugin.defaultLayer,
      Truncate.defaultLayer,
      Agent.defaultLayer,
      Config.defaultLayer,
      RuntimeFlags.layer(),
    ),
  )
}

function ctxFor(agent: string) {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

async function seedOrg(dir: string) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(ORG))
}

/** Two completed runs: "eng" always completes (chief-eng stays healthy), "mkt" always fails
 * (chief-mkt's error rate exceeds OrgMetrics' 20% ceiling -> "unhealthy"). Varies cost per run so
 * this also exercises OrgMetrics' avgCostPerStage, not just the pass/fail outcome. */
async function seedRuns(dir: string) {
  const run1 = await OrgState.create(dir, ORG, "idea one")
  await OrgState.update(dir, run1.runID, (run) => {
    run.stages["eng"]!.status = "completed"
    run.stages["eng"]!.costs = { ses_eng_1: 1.5 }
    run.stages["mkt"]!.status = "failed"
    run.stages["mkt"]!.costs = { ses_mkt_1: 0.5 }
  })

  const run2 = await OrgState.create(dir, ORG, "idea two")
  await OrgState.update(dir, run2.runID, (run) => {
    run.stages["eng"]!.status = "completed"
    run.stages["eng"]!.costs = { ses_eng_2: 2.0 }
    run.stages["mkt"]!.status = "failed"
    run.stages["mkt"]!.costs = { ses_mkt_2: 0.75 }
  })
}

describe("org_route tool", () => {
  test("org_route is registered under the org_ id prefix (visibility + primary-mode gates apply)", async () => {
    const runtime = makeRuntime()
    const info = await runtime.runPromise(RouteTaskTool)
    expect(info.id).toBe("org_route")
    expect(info.id.startsWith("org_")).toBe(true)
  })

  test("org_route rejects a non-CEO agent", async () => {
    await using tmp = await tmpdir({ config: { agent: AGENT_CONFIG } })
    await seedOrg(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(RouteTaskTool.pipe(Effect.flatMap((info) => info.init())))
        const exit = await Effect.runPromiseExit(
          tool.execute({ capabilities: ["swift", "ios"] }, ctxFor("chief-eng")),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Cause.squash(exit.cause)
        expect((error as Error).message).toContain('org tools are reserved for the CEO agent "ceo"')
      },
    })
  })

  test("ranks the capability-matched + healthy chief first, over a mismatched + unhealthy one", async () => {
    await using tmp = await tmpdir({ config: { agent: AGENT_CONFIG } })
    await seedOrg(tmp.path)
    await seedRuns(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(RouteTaskTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(
          tool.execute({ capabilities: ["swift", "ios"] }, ctxFor("ceo")),
        )
        const body = JSON.parse(out.output)
        const ranked = body.ranked as Array<{
          agent: string
          matchScore: number
          score: number
          health?: { band: string; score: number }
        }>

        expect(ranked.map((r) => r.agent)).toEqual(["chief-eng", "chief-mkt"])

        const eng = ranked[0]!
        const mkt = ranked[1]!
        expect(eng.agent).toBe("chief-eng")
        expect(eng.matchScore).toBe(1)
        expect(eng.health?.band).toBe("healthy")

        expect(mkt.agent).toBe("chief-mkt")
        expect(mkt.matchScore).toBe(0)
        expect(mkt.health?.band).toBe("unhealthy")

        expect(eng.score).toBeGreaterThan(mkt.score)
      },
    })
  })

  test("ranks a stage's workers, not the chiefs, when `stage` is given", async () => {
    await using tmp = await tmpdir({ config: { agent: AGENT_CONFIG } })
    await seedOrg(tmp.path)
    await seedRuns(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(RouteTaskTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(
          tool.execute({ stage: "eng", capabilities: ["swift"] }, ctxFor("ceo")),
        )
        const body = JSON.parse(out.output)
        const ranked = body.ranked as Array<{ agent: string }>

        expect(ranked.map((r) => r.agent)).toEqual(["worker-eng"])
      },
    })
  })
})
