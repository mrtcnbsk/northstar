// kilocode_change - new file
// Task 8.2 (EPIC 8 / TUI Cockpit): RED tests for the pure hard-stop message builder. Mirrors
// `gateMessage` (gate-card.ts) — the Cockpit's stop control never calls `OrgRunner.stop` directly
// (the cockpit is READ-ONLY over run state); it sends this string as a CEO-instruction chat
// message via `sdk.client.session.prompt`, and `ceo.md`'s protocol step 8 turns it into `org_stop`.
import { describe, expect, test } from "bun:test"
import { stopMessage } from "../../../src/kilocode/cockpit/stop"

describe("stopMessage", () => {
  test("embeds the runID and the reason", () => {
    expect(stopMessage("run-123", "user requested stop")).toBe("stop run run-123: user requested stop")
  })

  test("falls back to the placeholder run reference only when runID is genuinely absent", () => {
    expect(stopMessage(undefined, "budget exceeded")).toBe("stop run the current run: budget exceeded")
  })
})
