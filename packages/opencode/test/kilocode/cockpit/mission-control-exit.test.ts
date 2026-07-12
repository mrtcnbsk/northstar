// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildEvaluatorPanel, loopGauge, stageTimeline } from "../../../src/kilocode/cockpit/cockpit-view"
import { conversationCard } from "../../../src/kilocode/cockpit/conversation"

const SRC = path.join(__dirname, "../../../src/kilocode/cockpit")
const read = (file: string) => readFileSync(path.join(SRC, file), "utf8")

describe("SP2 read-only / HTTP-only invariants", () => {
  test("cockpit sources never call organization mutators directly", () => {
    for (const file of ["view.tsx", "mission-strip.tsx", "mission-view.tsx", "conversation.ts", "cockpit-view.ts"]) {
      const source = read(file)
      expect(source).not.toContain("OrgRunner.stop")
      expect(source).not.toContain("OrgRunner.decide")
      expect(source).not.toContain("OrgNote.append")
    }
  })

  test("the view dispatches every mutation through orgRuns HTTP methods", () => {
    const view = read("view.tsx")
    for (const method of ["decision", "note", "plan", "pause", "stop"]) {
      expect(view).toMatch(new RegExp(`orgRuns\\s*\\.\\s*${method}`))
    }
    expect(view).not.toContain("session.prompt")
    expect(view).not.toContain("stopMessage")
  })

  test("the strip is presentational", () => {
    const strip = read("mission-strip.tsx")
    expect(strip).not.toContain("orgRuns")
    expect(strip).not.toContain("cockpit.card")
  })

  test("polling covers active and paused, but not terminal states", () => {
    expect(read("view.tsx")).toMatch(/status\s*!==\s*"active"\s*&&\s*status\s*!==\s*"paused"/)
  })

  test("card actions use production bindings and escalation owns the only active s binding", () => {
    const view = read("view.tsx")
    expect(view).toContain("cockpit.card.approve")
    expect(view).toContain("cockpit.card.steer")
    expect(view).toContain("cockpit.pause")
    expect(view).toContain("escalationClaimsS")
    expect(view).toMatch(/escalationClaimsS\s*\?\s*\[\]\s*:\s*\[\{\s*key:\s*"s",\s*cmd:\s*"cockpit\.stop"/)
  })
})

describe("SP2 builders compose on a paused final gate", () => {
  const detail = {
    run: {
      createdAt: "2026-07-12T10:00:00.000Z",
      status: "paused",
      auto: true,
      pausedReason: { kind: "final_gate", stage: "build", detail: "approve to ship" },
    },
    stages: [
      {
        stage: "build",
        status: "awaiting_approval",
        cost: 3,
        attempts: 3,
        startedAt: "2026-07-12T10:09:00.000Z",
        completedAt: null,
        decision: null,
        criteria: ["compiles", "documents the API"],
        iterations: 2,
        verdictHistory: [{ pass: false, reasons: ["the API is undocumented"], ts: 1 }],
      },
    ],
    loop: { maxIterations: 4, evaluatorModel: "haiku" },
  }

  test("evaluator, loop, timeline, and card agree", () => {
    const panel = buildEvaluatorPanel(detail)
    expect(panel.stage).toBe("build")
    expect(panel.criteria).toContainEqual({ text: "documents the API", met: false })
    const gauge = loopGauge(detail, Date.parse("2026-07-12T10:09:05.000Z"))
    expect(gauge.iteration).toBe(2)
    expect(gauge.elapsed).toBe("5s")
    expect(stageTimeline(detail as never).at(0)?.annotation).toBe("⏸ final kapı")
    expect(conversationCard(detail)).toEqual({ kind: "final_gate", stage: "build", detail: "approve to ship" })
  })
})
