// kilocode_change - new file
/**
 * Wave 8 (agent registry) EXIT TEST.
 *
 * Exit criterion (dossier): "agent scoreboard renders in console; rollback restores a prior
 * deliverable and invalidates downstream artifacts."
 *
 * Three load-bearing proofs, each driving REAL wired components rather than re-deriving expected
 * values from the same code under test:
 *
 *  1. GET /agents (the same HttpRouter harness as httpapi-agents.test.ts) renders per-chief
 *     scoreboard rows from two seeded runs, with cost summed to-the-cent (via an independently
 *     computed Math.round(x*100), not read back from the response), a health band, and correct
 *     run/stage counts. (W8.2 metrics rollup + W8.3 HTTP surface -> "scoreboard renders".)
 *
 *  2. OrgVersions.rollback restores a prior deliverable's EXACT bytes on a live run, and does so
 *     NON-DESTRUCTIVELY: the content it overwrites (written without ever being snapshotted first,
 *     mirroring the real chief-overwrites-in-place gap) is itself preserved and roll-forward-able.
 *     (W8.5 -> "rollback restores a prior deliverable".)
 *
 *  3. OrgGraph.impactRadius computes the transitive downstream set over a real 3-stage
 *     requires-graph (not a trivial single stage), and OrgRunner.decide(..., "revise") actually
 *     records that exact set as Stage.invalidatedDownstream when driven through a live run.
 *     (W8.6 -> "invalidates downstream artifacts".)
 */
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { AgentsPaths } from "../../../src/kilocode/server/httpapi/groups/agents"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgVersions } from "../../../src/kilocode/organization/versions"
import { OrgGraph } from "../../../src/kilocode/organization/graph"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { advance1 } from "./batch-adapter"

void Log.init({ print: false })

type Json = Record<string, unknown>

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler

  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        HttpApiServer.context,
      )
    },
  }
}

function rec(input: unknown): Json {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object")
  return input as Json
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// ---------------------------------------------------------------------------------------------
// 1. Scoreboard renders (HTTP): GET /agents over the real HttpRouter harness.
// ---------------------------------------------------------------------------------------------

const SCOREBOARD_ORG_RAW = {
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    build: { chief: "build-chief", workers: ["engineer"] },
    ship: { chief: "ship-chief", workers: ["release-manager"] },
  },
  pipeline: [{ stage: "plan" }, { stage: "build" }, { stage: "ship" }],
}
const SCOREBOARD_ORG = OrgSchema.parse(SCOREBOARD_ORG_RAW)

// plan-chief's run1 costs are the classic 0.1 + 0.2 IEEE754 case (0.30000000000000004 in a naive
// float sum) - deliberately adversarial so a scoreboard that sums floats and displays them raw,
// instead of rounding to the cent, would fail this assertion.
const PLAN_R1 = { p1: 0.1, p1b: 0.2 }
const PLAN_R2 = { p2: 0.1 }
const BUILD_R1 = { b1: 2.22, b2: 1.1 } // run2's build FAILS with no cost captured
const SHIP_R1 = { s1: 0.33 }
const SHIP_R2 = { s2: 0.67 } // run2's ship is awaiting_approval (blocked, not terminal)

const planExpectedCents = Math.round(PLAN_R1.p1 * 100 + PLAN_R1.p1b * 100 + PLAN_R2.p2 * 100) // 40
const buildExpectedCents = Math.round(BUILD_R1.b1 * 100 + BUILD_R1.b2 * 100) // 332
const shipExpectedCents = Math.round(SHIP_R1.s1 * 100 + SHIP_R2.s2 * 100) // 100

async function writeScoreboardOrgFile(projectDir: string): Promise<void> {
  await Bun.write(OrgSchema.organizationPath(projectDir), JSON.stringify(SCOREBOARD_ORG_RAW))
}

/** Run 1: every stage completed. */
async function seedScoreboardRun1(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, SCOREBOARD_ORG, "scoreboard idea one")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["plan"].status = "completed"
    s.stages["plan"].costs = { ...PLAN_R1 }
    s.stages["plan"].attempts = 1
    s.stages["build"].status = "completed"
    s.stages["build"].costs = { ...BUILD_R1 }
    s.stages["build"].attempts = 1
    s.stages["ship"].status = "completed"
    s.stages["ship"].costs = { ...SHIP_R1 }
    s.stages["ship"].attempts = 1
  })
  return run.runID
}

/** Run 2: plan completed, build FAILED (no cost), ship awaiting_approval (blocked). */
async function seedScoreboardRun2(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, SCOREBOARD_ORG, "scoreboard idea two")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["plan"].status = "completed"
    s.stages["plan"].costs = { ...PLAN_R2 }
    s.stages["plan"].attempts = 1
    s.stages["build"].status = "failed"
    s.stages["build"].attempts = 2
    s.stages["ship"].status = "awaiting_approval"
    s.stages["ship"].costs = { ...SHIP_R2 }
    s.stages["ship"].attempts = 1
  })
  return run.runID
}

const cents = (n: unknown): number => Math.round((n as number) * 100)

describe("Wave 8 exit: agent scoreboard renders via GET /agents", () => {
  test("per-chief rows: cost to the cent, health band, run/stage counts", async () => {
    await using tmp = await tmpdir()
    await writeScoreboardOrgFile(tmp.path)
    const api = app()

    await seedScoreboardRun1(tmp.path)
    await seedScoreboardRun2(tmp.path)

    const response = await api.request(AgentsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const agents = body.agents as Json[]
    expect(agents).toHaveLength(3)
    const byAgent = Object.fromEntries(agents.map((a) => [a.agent, a]))

    // plan-chief: both runs' plan stages completed, no failures -> healthy, full score. Cost is the
    // adversarial 0.1+0.2+0.1 float sum, rounded to the cent independently of the endpoint.
    const plan = rec(byAgent["plan-chief"])
    expect(plan.runs).toBe(2)
    expect(plan.stages).toBe(2)
    expect(cents(plan.totalCost)).toBe(planExpectedCents)
    expect(plan.completed).toBe(2)
    expect(plan.failed).toBe(0)
    expect(plan.successRate).toBe(1)
    const planHealth = rec(plan.health)
    expect(planHealth.band).toBe("healthy")
    expect(planHealth.score).toBe(100)

    // build-chief: 1 completed + 1 failed -> 50% error rate exceeds the 20% ceiling -> unhealthy.
    const build = rec(byAgent["build-chief"])
    expect(build.runs).toBe(2)
    expect(build.stages).toBe(2)
    expect(cents(build.totalCost)).toBe(buildExpectedCents)
    expect(build.completed).toBe(1)
    expect(build.failed).toBe(1)
    expect(build.successRate).toBe(0.5)
    const buildHealth = rec(build.health)
    expect(buildHealth.band).toBe("unhealthy")
    expect(buildHealth.score).toBeLessThan(50)

    // ship-chief: 1 completed + 1 awaiting_approval (blocked, non-terminal, not a failure) -> healthy.
    const ship = rec(byAgent["ship-chief"])
    expect(ship.runs).toBe(2)
    expect(ship.stages).toBe(2)
    expect(cents(ship.totalCost)).toBe(shipExpectedCents)
    expect(ship.completed).toBe(1)
    expect(ship.blocked).toBe(1)
    expect(ship.failed).toBe(0)
    expect(ship.successRate).toBe(1)
    const shipHealth = rec(ship.health)
    expect(shipHealth.band).toBe("healthy")
  })
})

// ---------------------------------------------------------------------------------------------
// 2. Rollback restores a prior deliverable's exact bytes, non-destructively.
// ---------------------------------------------------------------------------------------------

describe("Wave 8 exit: rollback restores a prior deliverable exactly, non-destructively", () => {
  const ROLLBACK_ORG = OrgSchema.parse({
    ceo: "ceo",
    departments: { evaluation: { chief: "eval-chief", workers: ["market-research"] } },
    pipeline: [{ stage: "evaluation" }],
  })

  test("rollback(v1hash) restores v1's exact bytes; v2 (never snapshotted) survives for roll-forward", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ROLLBACK_ORG, "rollback exit fixture")
    const deliverableFile = OrgArtifacts.deliverablePath(tmp.path, run.runID, "evaluation")

    // v1: the chief's original deliverable, snapshotted while it's still live.
    const v1 = "# Evaluation v1\n\n" + "original market research content ".repeat(20)
    await mkdir(path.dirname(deliverableFile), { recursive: true })
    await Bun.write(deliverableFile, v1)
    const snap1 = await OrgVersions.snapshot(tmp.path, run.runID, "evaluation")
    expect(snap1).toBeDefined()
    expect(snap1?.hash).toBe(hashOf(v1))

    // v2: the chief overwrites the live deliverable IN PLACE, mirroring the real gap OrgVersions
    // closes - WITHOUT anything snapshotting v2's content first.
    const v2 = "# Evaluation v2\n\n" + "revised market research content ".repeat(20)
    await Bun.write(deliverableFile, v2)
    expect(await Bun.file(deliverableFile).text()).toBe(v2) // sanity: the live file really did change

    const result = await OrgVersions.rollback(tmp.path, run.runID, "evaluation", snap1!.hash)
    expect(result.restoredHash).toBe(snap1!.hash)

    // LOAD-BEARING: exact byte comparison against v1 (not "some non-empty content") - a no-op
    // rollback, or one that restored the wrong version, fails this.
    expect(await Bun.file(deliverableFile).text()).toBe(v1)
    expect(await Bun.file(deliverableFile).text()).not.toBe(v2)

    // NON-DESTRUCTIVE: v2 was overwritten without ever being explicitly snapshotted, yet rollback
    // preserved it (it snapshots whatever is live BEFORE overwriting) - it is now fetchable
    // byte-for-byte from OrgVersions.list, so roll-forward to v2 remains possible.
    const versions = await OrgVersions.list(tmp.path, run.runID, "evaluation")
    const byHash = Object.fromEntries(versions.map((v) => [v.hash, v]))
    expect(byHash[hashOf(v1)]).toBeDefined()
    expect(byHash[hashOf(v2)]).toBeDefined()
    expect(await Bun.file(byHash[hashOf(v2)]!.path).text()).toBe(v2)

    // Roll-forward proof: rolling back to v2's hash restores v2's exact bytes again.
    const rollForward = await OrgVersions.rollback(tmp.path, run.runID, "evaluation", hashOf(v2))
    expect(rollForward.restoredHash).toBe(hashOf(v2))
    expect(await Bun.file(deliverableFile).text()).toBe(v2)
  })
})

// ---------------------------------------------------------------------------------------------
// 3. A revise invalidates downstream artifacts: OrgGraph.impactRadius + runner-recorded
//    Stage.invalidatedDownstream over a real multi-stage requires-graph.
// ---------------------------------------------------------------------------------------------

const IMPACT_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    a: { chief: "a-chief", workers: ["a-worker"] },
    b: { chief: "b-chief", workers: ["b-worker"] },
    c: { chief: "c-chief", workers: ["c-worker"] },
  },
  // A gates on human approval so decide("revise") can be exercised on it; B requires A, C requires
  // B - a real (non-trivial) linear requires-chain, not a single isolated stage.
  pipeline: [{ stage: "a", gate: "human" }, { stage: "b", requires: ["a"] }, { stage: "c", requires: ["b"] }],
})

async function writeImpactDeliverable(projectDir: string, runID: string, stage: string) {
  const file = OrgArtifacts.deliverablePath(projectDir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

describe("Wave 8 exit: revise invalidates downstream artifacts", () => {
  test("impactRadius(a) is the transitive downstream set [b, c], in pipeline order", () => {
    expect(OrgGraph.impactRadius(IMPACT_ORG, "a")).toEqual(["b", "c"])
    expect(OrgGraph.impactRadius(IMPACT_ORG, "b")).toEqual(["c"])
    expect(OrgGraph.impactRadius(IMPACT_ORG, "c")).toEqual([])
  })

  test("OrgRunner.decide(..., 'revise') on A records invalidatedDownstream = impactRadius(A) on a live run", async () => {
    await using tmp = await tmpdir()
    const deps = { costOf: async () => 0.1 }
    const run = await OrgRunner.start(tmp.path, IMPACT_ORG, "idea wave8 exit impact radius")

    const instructed = await advance1(deps, tmp.path, IMPACT_ORG, run.runID, {})
    expect(instructed.kind).toBe("instruct")
    if (instructed.kind !== "instruct") throw new Error("unreachable")
    expect(instructed.stage).toBe("a")

    await writeImpactDeliverable(tmp.path, run.runID, "a")
    const gated = await advance1(deps, tmp.path, IMPACT_ORG, run.runID, { taskID: "ses_a" })
    expect(gated.kind).toBe("gate")
    if (gated.kind !== "gate") throw new Error("unreachable")
    expect(gated.stage).toBe("a")

    await OrgRunner.decide(tmp.path, IMPACT_ORG, run.runID, "revise", "needs another pass")

    const state = await OrgState.read(tmp.path, run.runID)
    // LOAD-BEARING: the exact transitive set over a real 3-stage requires-graph, cross-checked
    // against the pure OrgGraph computation - not a literal that happens to equal a trivial [] or a
    // single hardcoded stage.
    expect(state.stages["a"].invalidatedDownstream).toEqual(["b", "c"])
    expect(state.stages["a"].invalidatedDownstream).toEqual(OrgGraph.impactRadius(IMPACT_ORG, "a"))
    // b/c's own status is untouched by design - invalidatedDownstream is metadata surfaced to the
    // console/CEO, not an automatic reopen of the downstream stages.
    expect(state.stages["b"].status).toBe("pending")
    expect(state.stages["c"].status).toBe("pending")
  })
})

// ---------------------------------------------------------------------------------------------
// 4. Finding #1: the runner's OrgVersions.snapshot hooks (on-completion in settleRunningStage,
//    pre-revise in decide()) are the ONLY production path that ever populates the version store -
//    every other versions.test.ts case calls OrgVersions.snapshot/rollback DIRECTLY on hand-written
//    deliverables, so none of them would notice if the runner's best-effort hooks (both wrapped in
//    `.catch(() => undefined)`) were removed, broken, or mistimed. This drives the REAL OrgRunner
//    end to end and asserts on OrgVersions.list - a runner-PRODUCED artifact - never calling
//    OrgVersions.snapshot directly anywhere in this test.
// ---------------------------------------------------------------------------------------------

describe("Wave 8 exit: the runner's OrgVersions hooks actually produce snapshots (Finding #1)", () => {
  test("on-completion hook snapshots the accepted deliverable; decide('revise')'s pre-revise hook snapshots the live content again before it can be overwritten", async () => {
    await using tmp = await tmpdir()
    const deps = { costOf: async () => 0.1 }
    const run = await OrgRunner.start(tmp.path, IMPACT_ORG, "idea wave8 exit versions hook")
    const fileA = OrgArtifacts.deliverablePath(tmp.path, run.runID, "a")

    const instructed = await advance1(deps, tmp.path, IMPACT_ORG, run.runID, {})
    expect(instructed.kind).toBe("instruct")
    if (instructed.kind !== "instruct") throw new Error("unreachable")
    expect(instructed.stage).toBe("a")

    // Nothing has touched OrgVersions yet: the manifest must not exist before the chief even
    // produces a deliverable.
    expect(await OrgVersions.list(tmp.path, run.runID, "a")).toEqual([])

    // The chief "runs" and writes its deliverable (>=50 chars, OrgArtifacts.MIN_LENGTH) straight to
    // the live path - exactly how the real generic write tool would.
    const contentV1 = "# a deliverable v1\n\n" + "original runner-driven content ".repeat(3)
    expect(contentV1.trim().length).toBeGreaterThanOrEqual(50)
    await mkdir(path.dirname(fileA), { recursive: true })
    await Bun.write(fileA, contentV1)

    const gated = await advance1(deps, tmp.path, IMPACT_ORG, run.runID, { taskID: "ses_a1" })
    expect(gated.kind).toBe("gate")
    if (gated.kind !== "gate") throw new Error("unreachable")
    expect(gated.stage).toBe("a")

    // LOAD-BEARING (on-completion hook, runner.ts settleRunningStage ~L477): the only thing that
    // could have populated this manifest is the runner's best-effort snapshot fired right after the
    // deliverable was durably accepted. If that hook were deleted (or mistimed to fire before the
    // write, or targeted the wrong stage), this list would still be empty and the hash lookup below
    // would come back undefined - this test calls OrgVersions.snapshot nowhere above this point.
    const afterCompletion = await OrgVersions.list(tmp.path, run.runID, "a")
    expect(afterCompletion).toHaveLength(1)
    expect(afterCompletion[0]!.hash).toBe(hashOf(contentV1))
    expect(await Bun.file(afterCompletion[0]!.path).text()).toBe(contentV1)

    // A last-second edit lands on the live deliverable while it's awaiting_approval - content the
    // on-completion hook (already fired, above) never saw and could never have captured. This is
    // exactly the gap the module doc comment describes: "the chief overwrites the live .md in
    // place... without this the content being revised away would be unrecoverable once the chief's
    // next write lands." A future revise session's first write would clobber this content forever
    // unless something snapshots it first.
    const contentV2 = "# a deliverable v2 (edited pre-decision)\n\n" + "edited runner-driven content ".repeat(3)
    expect(contentV2).not.toBe(contentV1)
    await Bun.write(fileA, contentV2)

    await OrgRunner.decide(tmp.path, IMPACT_ORG, run.runID, "revise", "needs another pass")

    // LOAD-BEARING (pre-revise hook, runner.ts decide() ~L739): contentV2's hash was NEVER passed to
    // OrgVersions.snapshot by this test and cannot have come from the on-completion hook (which fired
    // before contentV2 existed). The only remaining path that could have recorded it is decide()'s
    // pre-revise snapshot call. If that hook were removed, the manifest would still have exactly the
    // one entry from `afterCompletion` and this hash lookup would be undefined.
    const afterRevise = await OrgVersions.list(tmp.path, run.runID, "a")
    expect(afterRevise.length).toBeGreaterThan(afterCompletion.length)
    const byHash = Object.fromEntries(afterRevise.map((v) => [v.hash, v]))
    expect(byHash[hashOf(contentV2)]).toBeDefined()
    expect(await Bun.file(byHash[hashOf(contentV2)]!.path).text()).toBe(contentV2)
    // v1 is still retrievable too - the pre-revise snapshot only ADDS, it never destroys history.
    expect(byHash[hashOf(contentV1)]).toBeDefined()

    // Sanity cross-check: decide("revise") computed reviseBaseline from the SAME live content
    // (contentV2) the pre-revise hook just snapshotted - both read the live file at decide-time.
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["a"].reviseBaseline).toBe(hashOf(contentV2))
  })
})
