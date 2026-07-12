// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { conversationCard, parseMention, type ConversationDetailView } from "../../../src/kilocode/cockpit/conversation"

function detail(over: Partial<ConversationDetailView> = {}): ConversationDetailView {
  return { run: { status: "active", auto: true, pausedReason: null }, stages: [], ...over }
}

describe("conversationCard", () => {
  test("paused escalation includes the latest failing verdict reasons", () => {
    expect(
      conversationCard(
        detail({
          run: {
            status: "paused",
            auto: true,
            pausedReason: { kind: "escalation", stage: "build", detail: "over budget" },
          },
          stages: [
            {
              stage: "build",
              status: "awaiting_approval",
              verdictHistory: [{ pass: false, reasons: ["burned the budget", "still failing"], ts: "t" }],
            },
          ],
        }),
      ),
    ).toEqual({
      kind: "escalation",
      stage: "build",
      reasons: ["burned the budget", "still failing"],
      detail: "over budget",
    })
  })

  test("paused final gate -> final-gate card", () => {
    expect(
      conversationCard(
        detail({
          run: {
            status: "paused",
            auto: true,
            pausedReason: { kind: "final_gate", stage: "ship", detail: "approve to ship" },
          },
        }),
      ),
    ).toEqual({ kind: "final_gate", stage: "ship", detail: "approve to ship" })
  })

  test("pre-auto human plan gate carries proposed criteria", () => {
    expect(
      conversationCard(
        detail({
          run: { status: "active", auto: false, pausedReason: null },
          stages: [{ stage: "plan", status: "awaiting_approval", criteria: ["ship a demo", "under $5"] }],
        }),
      ),
    ).toEqual({ kind: "plan", stage: "plan", criteria: ["ship a demo", "under $5"] })
  })

  test("running autonomous run with no gate -> none", () => {
    expect(conversationCard(detail())).toEqual({ kind: "none" })
  })

  test("auto run awaiting a non-paused gate -> none", () => {
    expect(
      conversationCard(
        detail({
          run: { status: "active", auto: true, pausedReason: null },
          stages: [{ stage: "build", status: "awaiting_approval" }],
        }),
      ),
    ).toEqual({ kind: "none" })
  })
})

describe("parseMention", () => {
  test("leading @name splits target and text", () => {
    expect(parseMention("@build-chief please add tests")).toEqual({ target: "build-chief", text: "please add tests" })
  })

  test("no mention broadcasts", () => {
    expect(parseMention("  slow down on spend  ")).toEqual({ target: "*", text: "slow down on spend" })
  })

  test("bare mention is plain broadcast text", () => {
    expect(parseMention("@lonely")).toEqual({ target: "*", text: "@lonely" })
  })
})
