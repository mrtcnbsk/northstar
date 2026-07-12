// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { buildEvaluatorPanel, type EvaluatorDetailView } from "../../../src/kilocode/cockpit/cockpit-view"

function detail(over: Partial<EvaluatorDetailView> = {}): EvaluatorDetailView {
  return {
    run: { status: "active", pausedReason: null },
    stages: [],
    loop: { maxIterations: 4, evaluatorModel: "haiku" },
    ...over,
  }
}

describe("buildEvaluatorPanel", () => {
  test("no active stage -> empty panel, defaults still resolved", () => {
    const panel = buildEvaluatorPanel(detail({ stages: [{ stage: "plan", status: "completed" }] }))
    expect(panel.stage).toBeNull()
    expect(panel.criteria).toEqual([])
    expect(panel.iteration).toBe(0)
    expect(panel.maxIterations).toBe(4)
    expect(panel.latestRejection).toBeNull()
    expect(panel.passed).toBeNull()
  })

  test("running stage, latest verdict failed -> called-out criteria are unmet, first reason surfaced", () => {
    const panel = buildEvaluatorPanel(
      detail({
        stages: [
          {
            stage: "build",
            status: "running",
            criteria: ["compiles cleanly", "has tests", "documents the API"],
            iterations: 2,
            verdictHistory: [
              { pass: false, reasons: ["no tests were added"], ts: "2026-07-12T10:00:00.000Z" },
              { pass: false, reasons: ["still no tests", "the API is undocumented"], ts: "2026-07-12T10:05:00.000Z" },
            ],
          },
        ],
      }),
    )
    expect(panel.stage).toBe("build")
    expect(panel.iteration).toBe(2)
    expect(panel.passed).toBe(false)
    expect(panel.latestRejection).toBe("still no tests")
    expect(panel.criteria).toEqual([
      { text: "compiles cleanly", met: true },
      { text: "has tests", met: true },
      { text: "documents the API", met: false },
    ])
  })

  test("latest verdict passed -> every criterion met, no rejection", () => {
    const panel = buildEvaluatorPanel(
      detail({
        stages: [
          {
            stage: "build",
            status: "running",
            criteria: ["a", "b"],
            iterations: 1,
            verdictHistory: [{ pass: true, reasons: [], ts: "2026-07-12T10:10:00.000Z" }],
          },
        ],
      }),
    )
    expect(panel.passed).toBe(true)
    expect(panel.latestRejection).toBeNull()
    expect(panel.criteria).toEqual([
      { text: "a", met: true },
      { text: "b", met: true },
    ])
  })

  test("failed verdict with no reasons -> generic rejection, criteria stay met", () => {
    const panel = buildEvaluatorPanel(
      detail({
        stages: [
          {
            stage: "build",
            status: "running",
            criteria: ["a"],
            iterations: 1,
            verdictHistory: [{ pass: false, reasons: [], ts: "t" }],
          },
        ],
      }),
    )
    expect(panel.latestRejection).toBe("rejected (no reason given)")
    expect(panel.criteria).toEqual([{ text: "a", met: true }])
  })

  test("paused run prefers pausedReason.stage over the first running/awaiting stage", () => {
    const panel = buildEvaluatorPanel(
      detail({
        run: { status: "paused", pausedReason: { kind: "final_gate", stage: "ship", detail: "approve to ship" } },
        stages: [
          { stage: "build", status: "running", criteria: ["x"], iterations: 3, verdictHistory: [] },
          { stage: "ship", status: "awaiting_approval", criteria: ["ready to ship"], iterations: 1, verdictHistory: [] },
        ],
      }),
    )
    expect(panel.stage).toBe("ship")
    expect(panel.iteration).toBe(1)
  })
})
