// kilocode_change - new file
// W9.1: unit tests for the PURE capability matcher (`capabilityScore`) and health-aware ranker
// (`rank`). Both are fabricated-input tests only (no filesystem, no clock reads), mirroring
// metrics.test.ts's style for `OrgMetrics.aggregate`/`health`.
import { describe, test, expect } from "bun:test"
import { OrgRouting } from "../../../src/kilocode/organization/routing"
import type { OrgMetrics } from "../../../src/kilocode/organization/metrics"

describe("OrgRouting.capabilityScore (pure)", () => {
  test("full overlap of need.capabilities with candidate.capabilities -> 1", () => {
    const score = OrgRouting.capabilityScore(
      { capabilities: ["swift", "ios"] },
      { agent: "swiftui-dev", capabilities: ["swift", "ios"] },
    )
    expect(score).toBe(1)
  })

  test("disjoint capabilities -> 0", () => {
    const score = OrgRouting.capabilityScore(
      { capabilities: ["swift", "ios"] },
      { agent: "copywriter", capabilities: ["marketing", "copy"] },
    )
    expect(score).toBe(0)
  })

  test("partial overlap -> strictly between 0 and 1 (need-coverage: matched/needed)", () => {
    const score = OrgRouting.capabilityScore(
      { capabilities: ["swift", "ios", "swiftui"] },
      { agent: "swiftui-dev", capabilities: ["swift"] },
    )
    // 1 of 3 needed capabilities covered
    expect(score).toBeCloseTo(1 / 3, 5)
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  test("need.capabilities undefined -> 0, never NaN", () => {
    const score = OrgRouting.capabilityScore({}, { agent: "swiftui-dev", capabilities: ["swift"] })
    expect(score).toBe(0)
    expect(Number.isNaN(score)).toBe(false)
  })

  test("need.capabilities empty array -> 0, never NaN", () => {
    const score = OrgRouting.capabilityScore(
      { capabilities: [] },
      { agent: "swiftui-dev", capabilities: ["swift"] },
    )
    expect(score).toBe(0)
    expect(Number.isNaN(score)).toBe(false)
  })

  test("candidate.capabilities undefined -> 0, never NaN", () => {
    const score = OrgRouting.capabilityScore({ capabilities: ["swift"] }, { agent: "swiftui-dev" })
    expect(score).toBe(0)
    expect(Number.isNaN(score)).toBe(false)
  })

  test("candidate.capabilities empty array -> 0, never NaN", () => {
    const score = OrgRouting.capabilityScore(
      { capabilities: ["swift"] },
      { agent: "swiftui-dev", capabilities: [] },
    )
    expect(score).toBe(0)
    expect(Number.isNaN(score)).toBe(false)
  })

  test("both sides undefined -> 0, never NaN", () => {
    const score = OrgRouting.capabilityScore({}, { agent: "swiftui-dev" })
    expect(score).toBe(0)
    expect(Number.isNaN(score)).toBe(false)
  })

  test("need.type present in candidate.preferredTypes adds a bounded bonus, still clamped to 1 on top of full overlap", () => {
    const withType = OrgRouting.capabilityScore(
      { capabilities: ["swift", "ios"], type: "mobile-app" },
      { agent: "swiftui-dev", capabilities: ["swift", "ios"], preferredTypes: ["mobile-app"] },
    )
    expect(withType).toBe(1) // full coverage (1) + bonus, clamped to 1
  })

  test("need.type bonus lifts a partial-match candidate's score without exceeding 1", () => {
    const withoutType = OrgRouting.capabilityScore(
      { capabilities: ["swift", "ios", "swiftui"] },
      { agent: "swiftui-dev", capabilities: ["swift"] },
    )
    const withType = OrgRouting.capabilityScore(
      { capabilities: ["swift", "ios", "swiftui"], type: "mobile-app" },
      { agent: "swiftui-dev", capabilities: ["swift"], preferredTypes: ["mobile-app"] },
    )
    expect(withType).toBeGreaterThan(withoutType)
    expect(withType).toBeLessThanOrEqual(1)
  })

  test("need.type not present in candidate.preferredTypes -> no bonus applied", () => {
    const matched = OrgRouting.capabilityScore(
      { capabilities: ["swift"], type: "mobile-app" },
      { agent: "swiftui-dev", capabilities: ["swift"], preferredTypes: ["backend-service"] },
    )
    const plain = OrgRouting.capabilityScore({ capabilities: ["swift"] }, { agent: "swiftui-dev", capabilities: ["swift"] })
    expect(matched).toBe(plain)
  })

  test("deterministic: same inputs always produce the same score", () => {
    const need = { capabilities: ["swift", "ios"], type: "mobile-app" }
    const candidate = { agent: "swiftui-dev", capabilities: ["swift"], preferredTypes: ["mobile-app"] }
    const a = OrgRouting.capabilityScore(need, candidate)
    const b = OrgRouting.capabilityScore(need, candidate)
    expect(a).toBe(b)
  })
})

describe("OrgRouting.rank (pure, health-aware)", () => {
  const healthy: OrgMetrics.Health = { score: 100, band: "healthy", reasons: [] }
  const unhealthy: OrgMetrics.Health = { score: 20, band: "unhealthy", reasons: ["error rate 50.0% exceeds ceiling 20.0%"] }

  test("a capability-matched + healthy candidate outranks a mismatched candidate AND an unhealthy matched candidate", () => {
    const need = { capabilities: ["swift", "ios"] }
    const candidates: OrgRouting.Candidate[] = [
      { agent: "mismatched-but-healthy", capabilities: ["marketing"] },
      { agent: "matched-but-unhealthy", capabilities: ["swift", "ios"] },
      { agent: "matched-and-healthy", capabilities: ["swift", "ios"] },
    ]
    const healthByAgent = new Map<string, OrgMetrics.Health>([
      ["mismatched-but-healthy", healthy],
      ["matched-but-unhealthy", unhealthy],
      ["matched-and-healthy", healthy],
    ])

    const ranked = OrgRouting.rank(need, candidates, healthByAgent)
    expect(ranked[0].agent).toBe("matched-and-healthy")
    expect(ranked.map((r) => r.agent)).toContain("mismatched-but-healthy")
    expect(ranked.map((r) => r.agent)).toContain("matched-but-unhealthy")
    // both losers rank below the winner
    expect(ranked[0].score).toBeGreaterThan(ranked.find((r) => r.agent === "mismatched-but-healthy")!.score)
    expect(ranked[0].score).toBeGreaterThan(ranked.find((r) => r.agent === "matched-but-unhealthy")!.score)
  })

  test("CRITICAL: missing health entry is a NEUTRAL (healthy) prior, not 0 - a matched-but-unrun agent beats a matched-but-unhealthy agent", () => {
    const need = { capabilities: ["swift", "ios"] }
    const candidates: OrgRouting.Candidate[] = [
      { agent: "matched-unrun", capabilities: ["swift", "ios"] }, // no entry in healthByAgent at all
      { agent: "matched-unhealthy", capabilities: ["swift", "ios"] },
    ]
    const healthByAgent = new Map<string, OrgMetrics.Health>([["matched-unhealthy", unhealthy]])

    const ranked = OrgRouting.rank(need, candidates, healthByAgent)
    expect(ranked[0].agent).toBe("matched-unrun")
    expect(ranked[0].health).toBeUndefined()
    // neutral prior treats the unrun agent as if health score ~= 100
    const unrun = ranked.find((r) => r.agent === "matched-unrun")!
    const unhealthyRanked = ranked.find((r) => r.agent === "matched-unhealthy")!
    expect(unrun.score).toBeGreaterThan(unhealthyRanked.score)
  })

  test("undefined/empty candidate capabilities never produce NaN and remain rankable", () => {
    const need = { capabilities: ["swift"] }
    const candidates: OrgRouting.Candidate[] = [{ agent: "no-caps" }]
    const ranked = OrgRouting.rank(need, candidates, new Map())
    expect(ranked).toHaveLength(1)
    expect(Number.isNaN(ranked[0].score)).toBe(false)
    expect(ranked[0].matchScore).toBe(0)
  })

  test("stable tie-break by agent name ascending when scores are equal", () => {
    const need = { capabilities: ["swift"] }
    const candidates: OrgRouting.Candidate[] = [
      { agent: "zeta-dev", capabilities: ["swift"] },
      { agent: "alpha-dev", capabilities: ["swift"] },
      { agent: "mid-dev", capabilities: ["swift"] },
    ]
    const ranked = OrgRouting.rank(need, candidates, new Map())
    expect(ranked.map((r) => r.agent)).toEqual(["alpha-dev", "mid-dev", "zeta-dev"])
  })

  test("reasons explain matched N/M capabilities and health band", () => {
    const need = { capabilities: ["swift", "ios"] }
    const candidates: OrgRouting.Candidate[] = [{ agent: "swiftui-dev", capabilities: ["swift"] }]
    const healthByAgent = new Map<string, OrgMetrics.Health>([["swiftui-dev", healthy]])
    const ranked = OrgRouting.rank(need, candidates, healthByAgent)
    expect(ranked[0].reasons.some((r) => r.includes("1/2"))).toBe(true)
    expect(ranked[0].reasons.some((r) => r.includes("healthy"))).toBe(true)
  })

  test("reasons note a neutral/unrated prior when no health entry exists", () => {
    const need = { capabilities: ["swift"] }
    const candidates: OrgRouting.Candidate[] = [{ agent: "swiftui-dev", capabilities: ["swift"] }]
    const ranked = OrgRouting.rank(need, candidates, new Map())
    expect(ranked[0].reasons.some((r) => /neutral|unrated/i.test(r))).toBe(true)
  })

  test("score formula: DEFAULT_WEIGHTS combine matchScore and health/100 as documented", () => {
    const need = { capabilities: ["swift", "ios"] }
    const candidate: OrgRouting.Candidate = { agent: "swiftui-dev", capabilities: ["swift"] }
    const health: OrgMetrics.Health = { score: 80, band: "healthy", reasons: [] }
    const ranked = OrgRouting.rank(need, [candidate], new Map([["swiftui-dev", health]]))
    const expectedMatch = OrgRouting.capabilityScore(need, candidate)
    const expectedScore = OrgRouting.DEFAULT_WEIGHTS.match * expectedMatch + OrgRouting.DEFAULT_WEIGHTS.health * (80 / 100)
    expect(ranked[0].score).toBeCloseTo(expectedScore, 10)
  })

  test("custom weights are honored when provided", () => {
    const need = { capabilities: ["swift"] }
    const candidate: OrgRouting.Candidate = { agent: "swiftui-dev", capabilities: ["swift"] }
    const health: OrgMetrics.Health = { score: 0, band: "unhealthy", reasons: ["bad"] }
    const weights: OrgRouting.RouteWeights = { match: 1, health: 0 }
    const ranked = OrgRouting.rank(need, [candidate], new Map([["swiftui-dev", health]]), weights)
    // health weight 0 -> score should equal matchScore exactly regardless of terrible health
    expect(ranked[0].score).toBe(1)
  })
})
