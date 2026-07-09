// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import { OrgPrompts } from "../../../src/kilocode/organization/prompts"

describe("OrgPrompts.stagePrompt", () => {
  const input = {
    stage: "frontend",
    idea: "a habit tracker for sailors",
    deliverablePath: "/proj/.kilo/org/runs/r1/deliverables/frontend.md",
    workers: ["swiftui-dev-1", "swiftui-dev-2"],
    shared: ["apple-docs"],
    priorDeliverables: [
      { stage: "planning", path: "/proj/.kilo/org/runs/r1/deliverables/planning.md" },
      { stage: "ux", path: "/proj/.kilo/org/runs/r1/deliverables/ux.md" },
    ],
  }

  test("contains the protocol essentials", () => {
    const prompt = OrgPrompts.stagePrompt(input)
    expect(prompt).toContain("frontend")
    expect(prompt).toContain(input.deliverablePath)
    expect(prompt).toContain("swiftui-dev-1")
    expect(prompt).toContain("apple-docs")
    expect(prompt).toContain("READY")
    expect(prompt).toContain("BLOCKED")
    for (const prior of input.priorDeliverables) expect(prompt).toContain(prior.path)
  })

  test("includes a revise note when present", () => {
    const prompt = OrgPrompts.stagePrompt({ ...input, reviseNote: "add dark mode screens" })
    expect(prompt).toContain("REVISION REQUESTED")
    expect(prompt).toContain("add dark mode screens")
  })

  test("empty priorDeliverables falls back to the first-stage note", () => {
    const prompt = OrgPrompts.stagePrompt({ ...input, priorDeliverables: [] })
    expect(prompt).toContain("(none — you are the first stage)")
  })

  test("empty shared falls back to the none note", () => {
    const prompt = OrgPrompts.stagePrompt({ ...input, shared: [] })
    expect(prompt).toContain("(none)")
  })
})
