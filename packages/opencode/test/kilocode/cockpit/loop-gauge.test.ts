// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { formatElapsed, loopGauge, type LoopDetailView } from "../../../src/kilocode/cockpit/cockpit-view"

const NOW = Date.parse("2026-07-12T10:10:05.000Z")

function detail(over: Partial<LoopDetailView> = {}): LoopDetailView {
  return {
    run: { createdAt: "2026-07-12T10:00:00.000Z", status: "active", pausedReason: null },
    stages: [],
    loop: { maxIterations: 4, evaluatorModel: "haiku" },
    ...over,
  }
}

describe("formatElapsed", () => {
  test("sub-minute, minute, and hour formats", () => {
    expect(formatElapsed(45_000)).toBe("45s")
    expect(formatElapsed(125_000)).toBe("2m 05s")
    expect(formatElapsed(3_725_000)).toBe("1h 02m 05s")
  })

  test("negative / non-finite clamps to 0s", () => {
    expect(formatElapsed(-1)).toBe("0s")
    expect(formatElapsed(Number.NaN)).toBe("0s")
  })
})

describe("loopGauge", () => {
  test("active stage: iteration from stage, elapsed from stage.startedAt, model + max from loop", () => {
    const gauge = loopGauge(
      detail({
        stages: [{ stage: "build", status: "running", iterations: 2, startedAt: "2026-07-12T10:10:00.000Z" }],
      }),
      NOW,
    )
    expect(gauge.iteration).toBe(2)
    expect(gauge.maxIterations).toBe(4)
    expect(gauge.evaluatorModel).toBe("haiku")
    expect(gauge.elapsed).toBe("5s")
    expect(gauge.atLimit).toBe(false)
  })

  test("no active stage: falls back to run.createdAt for elapsed, iteration 0", () => {
    const gauge = loopGauge(detail({ stages: [{ stage: "plan", status: "completed" }] }), NOW)
    expect(gauge.iteration).toBe(0)
    expect(gauge.elapsed).toBe("10m 05s")
  })

  test("iteration at/over max -> atLimit true; missing loop block uses defaults", () => {
    const gauge = loopGauge(
      {
        run: { createdAt: "2026-07-12T10:00:00.000Z", status: "active", pausedReason: null },
        stages: [{ stage: "build", status: "running", iterations: 4 }],
      },
      NOW,
    )
    expect(gauge.maxIterations).toBe(4)
    expect(gauge.evaluatorModel).toBe("haiku")
    expect(gauge.atLimit).toBe(true)
  })
})
