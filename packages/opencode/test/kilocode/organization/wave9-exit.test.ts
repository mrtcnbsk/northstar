// kilocode_change - new file
/**
 * Wave 9 (auto-selection & routing) EXIT TEST.
 *
 * Exit criterion (dossier): "auto-selection picks the capability-matched, healthiest agent over a
 * mismatched or unhealthy one; the org_route tool works end-to-end; workers surface their
 * capabilities for informed delegation."
 *
 * Three load-bearing proofs, each driving a REAL wired component rather than re-deriving expected
 * values from the same code under test:
 *
 *  1. OrgRouting.rank (pure): a 4-candidate scenario where matcher correctness (full-match >
 *     partial-match > disjoint) AND the missing-health neutral-prior (matched-unrun beats
 *     matched-unhealthy despite an IDENTICAL matchScore) both drive the SAME total order. A broken
 *     matcher, or a 0-instead-of-100 default for a missing health entry, reorders this list. (W9.1.)
 *
 *  2. org_route (tool, end-to-end): a live tmpdir org with a stage whose workers carry differing
 *     capabilities, run through the REAL RouteTaskTool.execute against seeded run history (so the
 *     tool's OrgMetrics.collect health lookup runs over real state.json files, not a stub) - the
 *     top-ranked worker is asserted by NAME, and a non-CEO caller is rejected by guardCeo. (W9.2.)
 *
 *  3. OrgPrompts.stagePrompt (informed delegation): a tagged worker renders "name (cap1, cap2)"
 *     in the exact stage prompt a chief reads; an untagged sibling worker stays a bare name. (W9.3.)
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { RouteTaskTool } from "../../../src/kilocode/tool/org-route"
import { OrgRouting } from "../../../src/kilocode/organization/routing"
import { OrgPrompts } from "../../../src/kilocode/organization/prompts"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import type { OrgMetrics } from "../../../src/kilocode/organization/metrics"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Plugin } from "../../../src/plugin"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

// ---------------------------------------------------------------------------------------------
// 1. Ranking intelligence (pure): capability matcher + health-aware ranker over a real 4-candidate
//    scenario that discriminates BOTH failure modes at once.
// ---------------------------------------------------------------------------------------------

describe("Wave 9 exit: OrgRouting.rank picks the capability-matched, healthiest agent", () => {
  test("full-match+healthy beats partial-match+unrun beats partial-match+unhealthy beats disjoint+healthy", () => {
    const need: OrgRouting.TaskNeed = { capabilities: ["swift", "ios", "swiftui"] }

    const healthy: OrgMetrics.Health = { score: 100, band: "healthy", reasons: [] }
    const unhealthy: OrgMetrics.Health = {
      score: 20,
      band: "unhealthy",
      reasons: ["error rate 50.0% exceeds ceiling 20.0%"],
    }

    // A: covers all 3 needed capabilities, healthy track record.
    const A: OrgRouting.Candidate = { agent: "a-full-match-healthy", capabilities: ["swift", "ios", "swiftui"] }
    // B: disjoint capabilities (matches nothing), healthy track record - a mismatched candidate
    // must lose even with a spotless health history.
    const B: OrgRouting.Candidate = { agent: "b-disjoint-healthy", capabilities: ["marketing", "copy", "design"] }
    // C: covers 2 of 3 needed capabilities (SAME coverage as D below), but its track record is
    // unhealthy.
    const C: OrgRouting.Candidate = { agent: "c-partial-match-unhealthy", capabilities: ["swift", "ios"] }
    // D: covers the SAME 2 of 3 as C, but has NEVER RUN - no entry in healthByAgent at all.
    const D: OrgRouting.Candidate = { agent: "d-partial-match-unrun", capabilities: ["swift", "ios"] }

    const healthByAgent = new Map<string, OrgMetrics.Health>([
      ["a-full-match-healthy", healthy],
      ["b-disjoint-healthy", healthy],
      ["c-partial-match-unhealthy", unhealthy],
      // d-partial-match-unrun deliberately absent: this is the case under test.
    ])

    const ranked = OrgRouting.rank(need, [B, C, D, A], healthByAgent) // shuffled input order on purpose

    // LOAD-BEARING: the exact total order, not just "A is somewhere near the top". A broken
    // matcher (e.g. Jaccard instead of need-coverage, or a coverage-fraction bug) would misplace B
    // relative to C/D; a 0-instead-of-neutral missing-health default would sink D below C.
    expect(ranked.map((r) => r.agent)).toEqual([
      "a-full-match-healthy",
      "d-partial-match-unrun",
      "c-partial-match-unhealthy",
      "b-disjoint-healthy",
    ])
    expect(ranked[0]!.agent).toBe("a-full-match-healthy")

    // The neutral-prior proof, isolated: C and D have the IDENTICAL matchScore (both cover 2/3 of
    // the need), so the only thing separating their rank is D's missing health entry defaulting to
    // a neutral/healthy prior instead of 0.
    const c = ranked.find((r) => r.agent === "c-partial-match-unhealthy")!
    const d = ranked.find((r) => r.agent === "d-partial-match-unrun")!
    expect(d.matchScore).toBe(c.matchScore)
    expect(d.health).toBeUndefined()
    expect(d.score).toBeGreaterThan(c.score)

    // reasons explain the top pick: full capability coverage + healthy band.
    expect(ranked[0]!.reasons.some((r) => r.includes("3/3"))).toBe(true)
    expect(ranked[0]!.reasons.some((r) => /healthy/i.test(r))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// 2. org_route end-to-end: real RouteTaskTool.execute against a live tmpdir org + seeded run
//    history, ranking a stage's workers by capability (the health lookup is exercised over real
//    state.json files, even though OrgMetrics attributes health at chief granularity - proving the
//    tool's wiring, not just OrgRouting.rank in isolation).
// ---------------------------------------------------------------------------------------------

const ROUTE_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    build: { chief: "build-chief", workers: ["ios-specialist", "backend-dev"] },
  },
  pipeline: [{ stage: "build" }],
})

// Config-inline agent definitions: ios-specialist's capabilities match the task need exactly;
// backend-dev's are disjoint from it, so its capability match score is 0 regardless of health.
const ROUTE_AGENT_CONFIG = {
  ceo: { mode: "primary" as const },
  "build-chief": { mode: "subagent" as const, capabilities: ["swift", "ios", "backend"] },
  "ios-specialist": { mode: "subagent" as const, capabilities: ["swift", "ios"] },
  "backend-dev": { mode: "subagent" as const, capabilities: ["node", "postgres"] },
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

async function seedRouteOrg(dir: string) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(ROUTE_ORG))
}

/** Two runs with varied cost/outcome for build-chief, so org_route's OrgMetrics.collect() health
 * lookup runs over REAL recorded run history rather than an empty roster - proving the tool's
 * health wiring actually executes end-to-end, not merely that it degrades gracefully when there is
 * no history at all. */
async function seedRouteRuns(dir: string) {
  const run1 = await OrgState.create(dir, ROUTE_ORG, "route exit idea one")
  await OrgState.update(dir, run1.runID, (run) => {
    run.stages["build"]!.status = "completed"
    run.stages["build"]!.costs = { ses_build_1: 1.0 }
  })

  const run2 = await OrgState.create(dir, ROUTE_ORG, "route exit idea two")
  await OrgState.update(dir, run2.runID, (run) => {
    run.stages["build"]!.status = "failed"
    run.stages["build"]!.costs = { ses_build_2: 0.5 }
  })
}

describe("Wave 9 exit: org_route ranks a stage's workers end-to-end as the CEO", () => {
  test("top-ranked worker (by name) is the capability-matched one, over a disjoint sibling worker", async () => {
    await using tmp = await tmpdir({ config: { agent: ROUTE_AGENT_CONFIG } })
    await seedRouteOrg(tmp.path)
    await seedRouteRuns(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(RouteTaskTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(
          tool.execute({ stage: "build", capabilities: ["swift", "ios"] }, ctxFor("ceo")),
        )
        const body = JSON.parse(out.output)
        const ranked = body.ranked as Array<{ agent: string; matchScore: number }>

        // LOAD-BEARING: the exact winning agent name and exact order, not "some non-empty
        // ranking" - a stage-scoping bug (e.g. returning chiefs instead of workers) or a matcher
        // bug would produce a different agent, a different order, or an empty list here.
        expect(ranked.map((r) => r.agent)).toEqual(["ios-specialist", "backend-dev"])
        expect(ranked[0]!.agent).toBe("ios-specialist")
        expect(ranked[0]!.matchScore).toBe(1)
        expect(ranked[1]!.matchScore).toBe(0)
      },
    })
  })

  test("a non-CEO agent is rejected by guardCeo", async () => {
    await using tmp = await tmpdir({ config: { agent: ROUTE_AGENT_CONFIG } })
    await seedRouteOrg(tmp.path)
    await seedRouteRuns(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(RouteTaskTool.pipe(Effect.flatMap((info) => info.init())))
        const exit = await Effect.runPromiseExit(
          tool.execute({ stage: "build", capabilities: ["swift", "ios"] }, ctxFor("build-chief")),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Cause.squash(exit.cause)
        expect((error as Error).message).toContain('org tools are reserved for the CEO agent "ceo"')
      },
    })
  })
})

// ---------------------------------------------------------------------------------------------
// 3. Delegation surface: OrgPrompts.stagePrompt annotates tagged workers with their capabilities
//    so a chief reading the prompt can route sub-tasks to the right worker.
// ---------------------------------------------------------------------------------------------

describe("Wave 9 exit: stagePrompt surfaces worker capabilities for informed delegation", () => {
  test('a tagged worker renders as "name (cap1, cap2)"; an untagged sibling stays a bare name', () => {
    const prompt = OrgPrompts.stagePrompt({
      stage: "build",
      idea: "wave 9 exit fixture idea",
      deliverablePath: "/proj/.kilo/org/runs/r1/deliverables/build.md",
      workers: ["ios-specialist", "backend-dev"],
      shared: [],
      priorDeliverables: [],
      workerCapabilities: { "ios-specialist": ["swift", "ios"] },
    })

    // LOAD-BEARING: the exact annotated substring a chief needs in order to route sub-tasks
    // correctly - a formatting regression (wrong separator, missing parens, wrong capability list)
    // fails this even though the worker's bare name would still appear elsewhere in the prompt.
    expect(prompt).toContain("ios-specialist (swift, ios)")
    // the untagged worker renders as a bare name, never annotated (back-compat with untagged
    // rosters, and proof this isn't just annotating every worker unconditionally).
    expect(prompt).not.toContain("backend-dev (")
    expect(prompt).toMatch(/(?<!\()backend-dev(?!\s*\()/)
  })
})
