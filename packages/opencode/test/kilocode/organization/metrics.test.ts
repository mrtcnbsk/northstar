// kilocode_change - new file
// W8.2: unit tests for the PURE per-agent metrics aggregator + health scorer, and the thin
// skip-on-corrupt cross-run collector. `aggregate`/`health` are fabricated-input tests only (no
// filesystem, no clock reads) mirroring postmortem.test.ts's style; `collect` gets a tmpdir
// integration test (it's the only I/O boundary in this module).
import { describe, test, expect } from "bun:test"
import path from "path"
import { OrgMetrics } from "../../../src/kilocode/organization/metrics"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { tmpdir } from "../../fixture/fixture"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "planning-chief", workers: ["architect"] },
    build: { chief: "build-chief", workers: ["swiftui-dev"] },
    marketing: { chief: "marketing-chief", workers: ["copywriter"] },
  },
  pipeline: [{ stage: "plan" }, { stage: "build" }, { stage: "marketing" }],
})

function completedRun(runID = "20260711-120000-journal-ai"): OrgState.Run {
  return {
    runID,
    idea: "A journaling app with on-device AI insights",
    createdAt: "2026-07-11T12:00:00.000Z",
    status: "completed",
    stages: {
      plan: {
        status: "completed",
        attempts: 1,
        costs: { ses_plan: 1.25 },
        startedAt: "2026-07-11T12:00:00.000Z",
        completedAt: "2026-07-11T12:10:00.000Z", // 600_000ms
      },
      build: {
        status: "completed",
        attempts: 2,
        costs: { ses_build_1: 2, ses_build_2: 1 },
        decision: "approve",
        startedAt: "2026-07-11T12:10:00.000Z",
        completedAt: "2026-07-11T12:30:00.000Z", // 1_200_000ms
      },
      marketing: {
        status: "completed",
        attempts: 1,
        costs: { ses_mkt: 0.5 },
        startedAt: "2026-07-11T12:30:00.000Z",
        completedAt: "2026-07-11T12:40:00.000Z", // 600_000ms
      },
    },
  }
}

describe("OrgMetrics.aggregate (pure)", () => {
  test("one AgentMetrics per chief, summed cost/stage-count/successRate/avgLatency for a single run", () => {
    const metrics = OrgMetrics.aggregate(ORG, [completedRun()])
    expect(metrics).toHaveLength(3)

    const byAgent = Object.fromEntries(metrics.map((m) => [m.agent, m]))
    expect(byAgent["planning-chief"]).toMatchObject({
      runs: 1,
      stages: 1,
      totalCost: 1.25,
      avgCostPerStage: 1.25,
      completed: 1,
      failed: 0,
      blocked: 0,
      successRate: 1,
      avgLatencyMs: 600_000,
    })
    expect(byAgent["build-chief"]).toMatchObject({
      runs: 1,
      stages: 1,
      totalCost: 3, // 2 + 1
      completed: 1,
      avgLatencyMs: 1_200_000,
    })
    expect(byAgent["marketing-chief"]).toMatchObject({
      runs: 1,
      stages: 1,
      totalCost: 0.5,
      avgLatencyMs: 600_000,
    })
  })

  test("cross-run aggregation: same chief across two runs sums cost/stages, distinguishes run count from stage count, and rolls up failed/blocked outcomes", () => {
    const run1 = completedRun("20260711-120000-journal-ai")
    const run2: OrgState.Run = {
      runID: "20260711-150000-second-idea",
      idea: "A second idea reusing the same org",
      createdAt: "2026-07-11T15:00:00.000Z",
      status: "halted",
      haltReason: 'stage "build" failed after 2 incomplete chief runs',
      stages: {
        plan: {
          status: "completed",
          attempts: 1,
          costs: { ses_plan2: 0.75 },
          startedAt: "2026-07-11T15:00:00.000Z",
          completedAt: "2026-07-11T15:05:00.000Z", // 300_000ms
        },
        build: { status: "failed", attempts: 2, incompleteAttempts: 2 },
        marketing: { status: "awaiting_approval", attempts: 1, costs: { ses_mkt2: 0.25 } },
      },
    }

    const metrics = OrgMetrics.aggregate(ORG, [run1, run2])
    const byAgent = Object.fromEntries(metrics.map((m) => [m.agent, m]))

    // planning-chief: 2 runs, 2 stages, cost 1.25 + 0.75 = 2, both completed -> successRate 1
    expect(byAgent["planning-chief"]).toMatchObject({
      runs: 2,
      stages: 2,
      totalCost: 2,
      completed: 2,
      failed: 0,
      successRate: 1,
    })
    // build-chief: 1 completed + 1 failed stage across 2 runs -> successRate 0.5
    expect(byAgent["build-chief"]).toMatchObject({
      runs: 2,
      stages: 2,
      completed: 1,
      failed: 1,
      successRate: 0.5,
    })
    // marketing-chief: 1 completed + 1 awaiting_approval ("blocked", non-terminal)
    expect(byAgent["marketing-chief"]).toMatchObject({
      runs: 2,
      stages: 2,
      completed: 1,
      failed: 0,
      blocked: 1,
      successRate: 1, // blocked is non-terminal; only completed/failed count toward successRate
    })
  })

  test("unknown cost (no costs map, no legacy cost field) is excluded from avgCostPerStage's denominator instead of counting as a false $0", () => {
    const run: OrgState.Run = {
      runID: "20260711-160000-unknown-cost",
      idea: "idea",
      createdAt: "2026-07-11T16:00:00.000Z",
      status: "active",
      stages: {
        plan: { status: "completed", attempts: 1, costs: { ses: 4 } },
        build: { status: "running", attempts: 1 }, // no costs/cost at all -> unknown, not $0
        marketing: { status: "pending", attempts: 0 },
      },
    }
    const metrics = OrgMetrics.aggregate(ORG, [run])
    const byAgent = Object.fromEntries(metrics.map((m) => [m.agent, m]))
    expect(byAgent["planning-chief"].avgCostPerStage).toBe(4)
    // build-chief has one stage, but its cost is unknown -> totalCost stays 0 (unknown never
    // distorts the sum, since it never contributed a spurious $0 average either way) and
    // avgCostPerStage is 0 over zero known-cost stages (documented fallback, see metrics.ts).
    expect(byAgent["build-chief"].totalCost).toBe(0)
    expect(byAgent["build-chief"].avgCostPerStage).toBe(0)
  })

  test("org drift: a stage present in run.stages but absent from org.departments (historical organization.jsonc changed) is skipped, not thrown", () => {
    const run: OrgState.Run = {
      runID: "20260711-170000-drift",
      idea: "idea",
      createdAt: "2026-07-11T17:00:00.000Z",
      status: "completed",
      stages: {
        plan: { status: "completed", attempts: 1, costs: { ses: 1 } },
        "retired-stage": { status: "completed", attempts: 1, costs: { ses: 99 } },
      },
    }
    expect(() => OrgMetrics.aggregate(ORG, [run])).not.toThrow()
    const metrics = OrgMetrics.aggregate(ORG, [run])
    // Only planning-chief shows up; the $99 from the drifted stage must not leak into any bucket.
    expect(metrics).toHaveLength(1)
    expect(metrics[0].agent).toBe("planning-chief")
    expect(metrics[0].totalCost).toBe(1)
  })

  test("successRate defaults to 1 when a chief has no terminal (completed/failed) stages yet", () => {
    const run: OrgState.Run = {
      runID: "20260711-180000-no-terminal",
      idea: "idea",
      createdAt: "2026-07-11T18:00:00.000Z",
      status: "active",
      stages: {
        plan: { status: "running", attempts: 1 },
      },
    }
    const metrics = OrgMetrics.aggregate(ORG, [run])
    expect(metrics).toHaveLength(1)
    expect(metrics[0]).toMatchObject({ completed: 0, failed: 0, successRate: 1, avgLatencyMs: null })
  })

  test("avgLatencyMs is null when no stage for that chief has both startedAt and completedAt", () => {
    const run: OrgState.Run = {
      runID: "20260711-190000-no-latency",
      idea: "idea",
      createdAt: "2026-07-11T19:00:00.000Z",
      status: "completed",
      stages: {
        plan: { status: "completed", attempts: 1, costs: { ses: 1 }, startedAt: "2026-07-11T19:00:00.000Z" }, // no completedAt
      },
    }
    const metrics = OrgMetrics.aggregate(ORG, [run])
    expect(metrics[0].avgLatencyMs).toBeNull()
  })
})

describe("OrgMetrics.health (pure, threshold-driven)", () => {
  const base: OrgMetrics.AgentMetrics = {
    agent: "planning-chief",
    runs: 5,
    stages: 10,
    totalCost: 10,
    avgCostPerStage: 1,
    completed: 9,
    failed: 1,
    blocked: 0,
    successRate: 0.9,
    avgLatencyMs: 60_000,
  }

  test("well within thresholds -> healthy, no reasons, full score", () => {
    const h = OrgMetrics.health(base)
    expect(h.band).toBe("healthy")
    expect(h.reasons).toEqual([])
    expect(h.score).toBe(100)
  })

  test("error rate exactly AT the ceiling is not penalized (boundary is exclusive: only strictly-above triggers)", () => {
    const thresholds = { errorRateCeiling: 0.1, latencyCeilingMs: 1_000_000 }
    const m = { ...base, stages: 10, failed: 1 } // errorRate = 0.1, exactly the ceiling
    const h = OrgMetrics.health(m, thresholds)
    expect(h.reasons.some((r) => r.includes("error rate"))).toBe(false)
    expect(h.band).toBe("healthy")
  })

  test("error rate just above the ceiling is penalized and reasoned", () => {
    const thresholds = { errorRateCeiling: 0.1, latencyCeilingMs: 1_000_000 }
    const m = { ...base, stages: 10, failed: 2 } // errorRate = 0.2 > 0.1
    const h = OrgMetrics.health(m, thresholds)
    expect(h.reasons.some((r) => r.includes("error rate"))).toBe(true)
    expect(h.score).toBeLessThan(100)
  })

  test("avgLatencyMs === null is never penalized (unknown latency is not treated as bad latency)", () => {
    const m = { ...base, avgLatencyMs: null }
    const h = OrgMetrics.health(m, { errorRateCeiling: 1, latencyCeilingMs: 1 })
    expect(h.reasons.some((r) => r.includes("latency"))).toBe(false)
  })

  test("high latency is penalized and reasoned", () => {
    const thresholds = { errorRateCeiling: 1, latencyCeilingMs: 1_000 }
    const m = { ...base, avgLatencyMs: 5_000 }
    const h = OrgMetrics.health(m, thresholds)
    expect(h.reasons.some((r) => r.includes("latency"))).toBe(true)
    expect(h.score).toBeLessThan(100)
  })

  test("both error rate and latency bad -> unhealthy band, two reasons, score floors at 0", () => {
    const thresholds = { errorRateCeiling: 0, latencyCeilingMs: 0 }
    const m = { ...base, failed: 10, stages: 10, avgLatencyMs: 999 }
    const h = OrgMetrics.health(m, thresholds)
    expect(h.reasons.length).toBe(2)
    expect(h.band).toBe("unhealthy")
    expect(h.score).toBe(0)
  })

  test("default thresholds are used when none are passed (no throw, deterministic result)", () => {
    const h1 = OrgMetrics.health(base)
    const h2 = OrgMetrics.health(base)
    expect(h1).toEqual(h2)
  })
})

describe("OrgMetrics.collect (async, tmpdir, skip-on-corrupt)", () => {
  test("reads every run under .kilo/org/runs, tolerates one corrupt state.json by skipping it, and aggregates the rest", async () => {
    await using tmp = await tmpdir()

    await Bun.write(
      OrgSchema.organizationPath(tmp.path),
      JSON.stringify({
        ceo: "ceo",
        departments: {
          plan: { chief: "planning-chief", workers: ["architect"] },
          build: { chief: "build-chief", workers: ["swiftui-dev"] },
          marketing: { chief: "marketing-chief", workers: ["copywriter"] },
        },
        pipeline: [{ stage: "plan" }, { stage: "build" }, { stage: "marketing" }],
      }),
    )

    const run1 = await OrgState.create(tmp.path, ORG, "first idea")
    await OrgState.update(tmp.path, run1.runID, (s) => {
      s.stages["plan"].status = "completed"
      s.stages["plan"].costs = { ses_a: 2 }
      s.stages["plan"].startedAt = "2026-07-11T12:00:00.000Z"
      s.stages["plan"].completedAt = "2026-07-11T12:05:00.000Z"
    })

    const run2 = await OrgState.create(tmp.path, ORG, "second idea")
    await OrgState.update(tmp.path, run2.runID, (s) => {
      s.stages["plan"].status = "completed"
      s.stages["plan"].costs = { ses_b: 3 }
      s.stages["plan"].startedAt = "2026-07-11T13:00:00.000Z"
      s.stages["plan"].completedAt = "2026-07-11T13:05:00.000Z"
    })

    // A corrupt run directory: unparsable JSON, simulating a crash mid-write. Must be skipped,
    // not thrown, and must not appear anywhere in the aggregated output.
    const corruptID = "20260711-999999-corrupt"
    await Bun.write(path.join(tmp.path, ".kilo", "org", "runs", corruptID, "state.json"), "{ not json")

    const metrics = await OrgMetrics.collect(tmp.path)
    const planningChief = metrics.find((m) => m.agent === "planning-chief")
    expect(planningChief).toBeDefined()
    expect(planningChief!.runs).toBe(2)
    expect(planningChief!.totalCost).toBe(5) // 2 + 3, corrupt run excluded entirely
  })

  test("tolerates a missing organization.jsonc by treating it as an empty org (no agents, no throw)", async () => {
    await using tmp = await tmpdir()
    await OrgState.create(tmp.path, ORG, "an idea with no organization.jsonc on disk")

    const metrics = await OrgMetrics.collect(tmp.path)
    expect(metrics).toEqual([])
  })
})
