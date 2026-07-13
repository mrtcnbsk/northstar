// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { stageAnnotation } from "../../../src/kilocode/cockpit/cockpit-view"

describe("stageAnnotation", () => {
  test("final gate wins over revision count", () => {
    expect(stageAnnotation({ iterations: 3, maxIterations: 4, isFinalGate: true })).toBe("⏸ final gate")
  })

  test("revision count when iterations > 0 and not a final gate", () => {
    expect(stageAnnotation({ iterations: 2, maxIterations: 4, isFinalGate: false })).toBe("↻ revision 2/4")
  })

  test("no annotation for a fresh stage", () => {
    expect(stageAnnotation({ iterations: 0, maxIterations: 4, isFinalGate: false })).toBeUndefined()
    expect(stageAnnotation({ maxIterations: 4, isFinalGate: false })).toBeUndefined()
  })
})
