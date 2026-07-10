import { describe, expect, test } from "bun:test"
import type { OrgRunDetailResponse } from "@kilocode/sdk/v2/client"
import { auditTrail, awaitingGateStages, formatCost, runStatusBadge, stageBadge, stageTimeline } from "./org-runs-view"

function detail(overrides: Partial<OrgRunDetailResponse> = {}): OrgRunDetailResponse {
  return {
    run: {
      runID: "run-1",
      idea: "Test idea",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "active",
      stages: {},
    },
    audit: [],
    totalCost: 0,
    stages: [],
    ...overrides,
  }
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

describe("runStatusBadge", () => {
  test("maps run status to badge variant", () => {
    expect(runStatusBadge("active")).toBe("secondary")
    expect(runStatusBadge("halted")).toBe("destructive")
    expect(runStatusBadge("completed")).toBe("default")
    expect(runStatusBadge("unknown")).toBe("outline")
  })
})

describe("stageBadge", () => {
  test("maps stage status to badge variant", () => {
    expect(stageBadge("pending")).toBe("outline")
    expect(stageBadge("running")).toBe("secondary")
    expect(stageBadge("awaiting_approval")).toBe("default")
    expect(stageBadge("completed")).toBe("secondary")
    expect(stageBadge("failed")).toBe("destructive")
  })
})

describe("stageTimeline", () => {
  test("preserves stage order and derives badge variants", () => {
    const data = detail({
      stages: [
        {
          stage: "feasibility",
          status: "completed",
          cost: 1.5,
          attempts: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:05:00.000Z",
          decision: "approve",
        },
        {
          stage: "edge",
          status: "awaiting_approval",
          cost: 2,
          attempts: 1,
          startedAt: "2026-01-01T00:05:00.000Z",
          completedAt: "",
          decision: "approve",
        },
        {
          stage: "durability",
          status: "pending",
          cost: "NaN",
          attempts: 0,
          startedAt: "",
          completedAt: "",
          decision: "approve",
        },
      ],
    })

    expect(stageTimeline(data)).toEqual([
      {
        stage: "feasibility",
        status: "completed",
        cost: 1.5,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:05:00.000Z",
        decision: "approve",
        badgeVariant: "secondary",
      },
      {
        stage: "edge",
        status: "awaiting_approval",
        cost: 2,
        startedAt: "2026-01-01T00:05:00.000Z",
        completedAt: "",
        decision: "approve",
        badgeVariant: "default",
      },
      {
        stage: "durability",
        status: "pending",
        cost: 0,
        startedAt: "",
        completedAt: "",
        decision: "approve",
        badgeVariant: "outline",
      },
    ])
  })

  test("returns an empty list for undefined detail", () => {
    expect(stageTimeline(undefined)).toEqual([])
  })
})

describe("awaitingGateStages", () => {
  test("picks only the awaiting_approval stages", () => {
    const data = detail({
      stages: [
        { stage: "feasibility", status: "completed", cost: 1, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
        { stage: "edge", status: "awaiting_approval", cost: 2, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
        { stage: "durability", status: "awaiting_approval", cost: 0, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
      ],
    })

    expect(awaitingGateStages(data)).toEqual(["edge", "durability"])
  })

  test("returns an empty list when nothing is awaiting a gate", () => {
    const data = detail({
      stages: [
        { stage: "feasibility", status: "completed", cost: 1, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
      ],
    })

    expect(awaitingGateStages(data)).toEqual([])
    expect(awaitingGateStages(undefined)).toEqual([])
  })
})

describe("auditTrail", () => {
  test("returns the audit entries as-is", () => {
    const entries = [{ ts: "2026-01-01T00:00:00.000Z", stage: "edge", decision: "approve", note: "looks good" }]
    expect(auditTrail(detail({ audit: entries }))).toBe(entries)
    expect(auditTrail(undefined)).toEqual([])
  })
})
