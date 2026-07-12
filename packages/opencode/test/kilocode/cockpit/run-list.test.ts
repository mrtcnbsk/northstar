// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import type { OrgRunSummary } from "@kilocode/sdk/v2/client"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { buildRunList, dryRunReport } from "../../../src/kilocode/cockpit/cockpit-view"

const RUNS: OrgRunSummary[] = [
  {
    runID: "run-2",
    idea: "Second run (newest)",
    status: "active",
    createdAt: "2026-07-11T12:00:00.000Z",
    totalCost: 4.5,
    stageCount: 2,
    currentStage: "planning",
    awaitingGate: true,
  },
  {
    runID: "run-1",
    idea: "First run (oldest)",
    status: "halted",
    createdAt: "2026-07-10T09:00:00.000Z",
    totalCost: 12,
    stageCount: 3,
    currentStage: null as unknown as string,
    awaitingGate: false,
  },
]

describe("buildRunList", () => {
  test("maps summaries in the given (newest-first) order, carrying idea/status/cost/currentStage/awaitingGate + a status badge", () => {
    const rows = buildRunList(RUNS)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.runID)).toEqual(["run-2", "run-1"])

    expect(rows[0]).toEqual({
      runID: "run-2",
      idea: "Second run (newest)",
      status: "active",
      totalCost: 4.5,
      currentStage: "planning",
      awaitingGate: true,
      badge: "secondary",
    })
    expect(rows[1]).toEqual({
      runID: "run-1",
      idea: "First run (oldest)",
      status: "halted",
      totalCost: 12,
      currentStage: null,
      awaitingGate: false,
      badge: "destructive",
    })
  })

  test("a completed run badges 'default'; an unrecognized status badges 'outline'", () => {
    const rows = buildRunList([
      { ...RUNS[0], status: "completed" },
      { ...RUNS[0], status: "weird" as OrgRunSummary["status"] },
    ])
    expect(rows[0].badge).toBe("default")
    expect(rows[1].badge).toBe("outline")
  })

  test("coerces a NaN/Infinity totalCost sentinel to 0", () => {
    const rows = buildRunList([{ ...RUNS[0], totalCost: "NaN" as unknown as number }])
    expect(rows[0].totalCost).toBe(0)
  })
})

const VALID_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

const VALID_AGENTS = {
  ceo: { mode: "primary", subordinates: ["eval-chief", "planning-chief"] },
  "eval-chief": { mode: "subagent", subordinates: ["market-research"] },
  "planning-chief": { mode: "subagent", subordinates: ["architect"] },
  "market-research": { mode: "subagent" },
  architect: { mode: "subagent" },
}

describe("dryRunReport", () => {
  test("a valid org + a fully-consistent agent map -> ok:true, issues:[], right counts", () => {
    const report = dryRunReport(VALID_ORG, VALID_AGENTS)
    expect(report).toEqual({
      ok: true,
      departments: 2,
      stages: 2,
      agentCount: 5,
      issues: [],
    })
  })

  test("a pipeline dependency cycle -> ok:false, issues includes the cycle message", () => {
    const cyclic = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        a: { chief: "a-chief", workers: ["a-worker"] },
        b: { chief: "b-chief", workers: ["b-worker"] },
      },
      pipeline: [
        { stage: "a", requires: ["b"] },
        { stage: "b", requires: ["a"] },
      ],
    })
    const agents = {
      ceo: { mode: "primary", subordinates: ["a-chief", "b-chief"] },
      "a-chief": { mode: "subagent", subordinates: ["a-worker"] },
      "b-chief": { mode: "subagent", subordinates: ["b-worker"] },
      "a-worker": { mode: "subagent" },
      "b-worker": { mode: "subagent" },
    }

    const report = dryRunReport(cyclic, agents)
    expect(report.ok).toBe(false)
    expect(report.departments).toBe(2)
    expect(report.stages).toBe(2)
    expect(report.issues.some((e) => e.includes("dependency cycle"))).toBe(true)
  })

  test("a missing subordinate declaration -> ok:false, issues includes the crossCheck message", () => {
    const agents = {
      ceo: { mode: "primary", subordinates: ["eval-chief"] }, // missing planning-chief
      "eval-chief": { mode: "subagent", subordinates: ["market-research"] },
      "planning-chief": { mode: "subagent", subordinates: [] }, // missing architect
      "market-research": { mode: "subagent" },
      architect: { mode: "subagent" },
    }

    const report = dryRunReport(VALID_ORG, agents)
    expect(report.ok).toBe(false)
    expect(report.agentCount).toBe(5)
    expect(report.issues.some((e) => e.includes("architect"))).toBe(true)
    expect(report.issues.some((e) => e.includes("planning-chief"))).toBe(true)
  })
})
