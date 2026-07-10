import { describe, expect, test } from "bun:test"
import type { OrgRunDetailResponse } from "@kilocode/sdk/v2/client"
import {
  auditTrail,
  awaitingGateStages,
  awaitingSince,
  costRows,
  costTotal,
  formatCost,
  runStatusBadge,
  stageBadge,
  stageTimeline,
} from "./org-runs-view"

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

  test("maps a skipped stage (W4.4 conditional `when`) to a muted variant", () => {
    expect(stageBadge("skipped")).toBe("ghost")
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

describe("costRows", () => {
  test("preserves stage order and maps cost", () => {
    const data = detail({
      stages: [
        { stage: "feasibility", status: "completed", cost: 1.5, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
        { stage: "edge", status: "completed", cost: 0.25, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
        { stage: "durability", status: "awaiting_approval", cost: 0.5, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
      ],
    })

    expect(costRows(data)).toEqual([
      { stage: "feasibility", cost: 1.5 },
      { stage: "edge", cost: 0.25 },
      { stage: "durability", cost: 0.5 },
    ])
  })

  test("normalizes legacy non-finite cost values to 0", () => {
    const data = detail({
      stages: [{ stage: "durability", status: "pending", cost: "NaN", attempts: 0, startedAt: "", completedAt: "", decision: "approve" }],
    })

    expect(costRows(data)).toEqual([{ stage: "durability", cost: 0 }])
  })

  test("returns an empty list for undefined detail", () => {
    expect(costRows(undefined)).toEqual([])
  })
})

describe("costTotal", () => {
  test("sums of per-stage costs equal the API's totalCost to the cent", () => {
    const data = detail({
      totalCost: 2.25,
      stages: [
        { stage: "feasibility", status: "completed", cost: 1.5, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
        { stage: "edge", status: "completed", cost: 0.25, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
        { stage: "durability", status: "awaiting_approval", cost: 0.5, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
      ],
    })

    const sumOfStages = costRows(data).reduce((acc, row) => acc + row.cost, 0)
    expect(Math.round(sumOfStages * 100)).toBe(Math.round(costTotal(data) * 100))
    expect(costTotal(data)).toBe(2.25)
  })

  test("handles legacy non-finite totalCost", () => {
    expect(costTotal(detail({ totalCost: "NaN" }))).toBe(0)
  })

  test("returns 0 for undefined detail", () => {
    expect(costTotal(undefined)).toBe(0)
  })
})

describe("awaitingSince", () => {
  test("computes elapsed time for awaiting stages given a fixed now", () => {
    const now = new Date("2026-01-01T00:10:00.000Z").getTime()
    const data = detail({
      stages: [
        { stage: "feasibility", status: "completed", cost: 1, attempts: 1, startedAt: "", completedAt: "", decision: "approve" },
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
          status: "awaiting_approval",
          cost: 0,
          attempts: 1,
          startedAt: "2026-01-01T00:08:00.000Z",
          completedAt: "",
          decision: "approve",
        },
      ],
    })

    expect(awaitingSince(data, now)).toEqual([
      { stage: "edge", sinceMs: 5 * 60 * 1000 },
      { stage: "durability", sinceMs: 2 * 60 * 1000 },
    ])
  })

  test("returns empty when nothing is awaiting a gate", () => {
    const now = Date.now()
    const data = detail({
      stages: [{ stage: "feasibility", status: "completed", cost: 1, attempts: 1, startedAt: "", completedAt: "", decision: "approve" }],
    })

    expect(awaitingSince(data, now)).toEqual([])
    expect(awaitingSince(undefined, now)).toEqual([])
  })

  test("defaults sinceMs to 0 when startedAt is missing", () => {
    const now = Date.now()
    const data = detail({
      stages: [{ stage: "edge", status: "awaiting_approval", cost: 1, attempts: 1, startedAt: "", completedAt: "", decision: "approve" }],
    })

    expect(awaitingSince(data, now)).toEqual([{ stage: "edge", sinceMs: 0 }])
  })
})
