import { describe, expect, test } from "bun:test"
import type { AgentMetricsResponse, AgentMetricsRow } from "@kilocode/sdk/v2/client"
import { agentRows, formatCost, formatLatency, formatPercent, healthBadge } from "./agents-view"

// avgLatencyMs is `Schema.NullOr(Schema.Number)` server-side (see
// packages/opencode/src/kilocode/server/httpapi/groups/agents.ts) and the org's metrics rollup
// genuinely emits `null` when no stage has both startedAt/completedAt -- "no data" is a real wire
// value even though the current SDK codegen output for AgentMetricsRow.avgLatencyMs omits `null`
// from the union. Widen just that field here so factories can exercise the real runtime shape.
type RowOverrides = Partial<Omit<AgentMetricsRow, "avgLatencyMs">> & {
  avgLatencyMs?: AgentMetricsRow["avgLatencyMs"] | null
}

function row(overrides: RowOverrides = {}): AgentMetricsRow {
  return {
    agent: "chief-feasibility",
    runs: 4,
    stages: 10,
    totalCost: 12.5,
    avgCostPerStage: 1.25,
    completed: 8,
    failed: 1,
    blocked: 1,
    successRate: 0.8,
    avgLatencyMs: 45_000,
    health: { score: 92, band: "healthy" },
    ...overrides,
  } as AgentMetricsRow
}

function res(agents: AgentMetricsRow[] = [row()]): AgentMetricsResponse {
  return { agents }
}

describe("formatCost", () => {
  test("rounds to 2 decimals", () => {
    expect(formatCost(2.25)).toBe("$2.25")
    expect(formatCost(5)).toBe("$5.00")
    expect(formatCost(2.256)).toBe("$2.26")
  })

  test("handles zero and non-finite input", () => {
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(Number.NaN)).toBe("$0.00")
  })
})

describe("formatPercent", () => {
  test("formats a 0..1 rate as a rounded percent", () => {
    expect(formatPercent(0.8)).toBe("80%")
    expect(formatPercent(1)).toBe("100%")
    expect(formatPercent(0)).toBe("0%")
  })

  test("handles non-finite input", () => {
    expect(formatPercent(Number.NaN)).toBe("0%")
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0%")
  })
})

describe("formatLatency", () => {
  test("formats sub-second latency in milliseconds", () => {
    expect(formatLatency(450)).toBe("450ms")
    expect(formatLatency(999)).toBe("999ms")
  })

  test("formats latency at or above 1s in seconds", () => {
    expect(formatLatency(1500)).toBe("1.5s")
    expect(formatLatency(60_000)).toBe("60.0s")
  })

  test("renders a placeholder for null (no data, distinct from zero)", () => {
    expect(formatLatency(null)).toBe("—")
  })

  test("renders a placeholder for non-finite input", () => {
    expect(formatLatency(Number.NaN)).toBe("—")
  })
})

describe("healthBadge", () => {
  test("maps health band to badge variant", () => {
    expect(healthBadge("healthy")).toBe("default")
    expect(healthBadge("degraded")).toBe("secondary")
    expect(healthBadge("unhealthy")).toBe("destructive")
  })
})

describe("agentRows", () => {
  test("maps every field from the wire row", () => {
    const data = res([row()])

    expect(agentRows(data)).toEqual([
      {
        agent: "chief-feasibility",
        runs: 4,
        stages: 10,
        totalCost: 12.5,
        avgCostPerStage: 1.25,
        completed: 8,
        failed: 1,
        blocked: 1,
        successRate: 0.8,
        avgLatencyMs: 45_000,
        healthScore: 92,
        healthBand: "healthy",
        badgeVariant: "default",
      },
    ])
  })

  test("normalizes non-finite numeric fields to 0", () => {
    const data = res([
      row({
        runs: "NaN",
        stages: "Infinity",
        totalCost: "-Infinity",
        avgCostPerStage: "NaN",
        completed: "NaN",
        failed: "NaN",
        blocked: "NaN",
        successRate: "NaN",
        health: { score: "NaN", band: "degraded" },
      }),
    ])

    expect(agentRows(data)[0]).toMatchObject({
      runs: 0,
      stages: 0,
      totalCost: 0,
      avgCostPerStage: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      successRate: 0,
      healthScore: 0,
    })
  })

  test("normalizes avgLatencyMs: null to null (no data, never coerced to 0)", () => {
    const data = res([row({ avgLatencyMs: null })])
    expect(agentRows(data)[0]?.avgLatencyMs).toBeNull()
  })

  test("normalizes a non-finite avgLatencyMs to null", () => {
    const data = res([row({ avgLatencyMs: "NaN" })])
    expect(agentRows(data)[0]?.avgLatencyMs).toBeNull()
  })

  test("sorts by health band (unhealthy first) then cost desc within a band", () => {
    const data = res([
      row({ agent: "b", totalCost: 5, health: { score: 90, band: "healthy" } }),
      row({ agent: "a", totalCost: 20, health: { score: 30, band: "unhealthy" } }),
      row({ agent: "c", totalCost: 8, health: { score: 60, band: "degraded" } }),
      row({ agent: "d", totalCost: 50, health: { score: 88, band: "healthy" } }),
    ])

    expect(agentRows(data).map((item) => item.agent)).toEqual(["a", "c", "d", "b"])
  })

  test("returns an empty list for an empty agents array", () => {
    expect(agentRows(res([]))).toEqual([])
  })

  test("returns an empty list for undefined input", () => {
    expect(agentRows(undefined)).toEqual([])
  })
})
