// kilocode_change - new file
// Task 7.2 (EPIC 7 / TUI Chat): pure grouping core for the agent selector roster.
// Org agents already flow into sync.data.agent (source: "organization"), but
// local.agent.list() drops every mode:"subagent" entry - which, per the org-template
// contract (templates.test.ts), is every chief/worker except the CEO. buildAgentOptions
// groups the FULL agent list into "Built-in" (source == null) and "Org"
// (source === "organization") sections so the dialog can render + surface the whole
// roster without touching the Tab-cycle contract in local.tsx.
import { describe, test, expect } from "bun:test"
import type { Agent } from "@kilocode/sdk/v2"
import { buildAgentOptions } from "@/kilocode/cli/cmd/tui/agent-roster"

function agent(overrides: Partial<Agent> & Pick<Agent, "name" | "mode">): Agent {
  return {
    permission: [],
    options: {},
    ...overrides,
  }
}

const fixture: Agent[] = [
  agent({ name: "code", mode: "primary", native: true }),
  agent({ name: "plan", mode: "primary", native: true }),
  agent({ name: "ask", mode: "primary", native: true }),
  agent({ name: "ceo", mode: "primary", source: "organization", displayName: "CEO" }),
  agent({ name: "analyst", mode: "subagent", source: "organization", displayName: "Analyst" }),
  agent({ name: "swiftui-dev-1", mode: "subagent", source: "organization" }),
  agent({ name: "secret-agent", mode: "subagent", source: "organization", displayName: "Secret", hidden: true }),
]

describe("buildAgentOptions", () => {
  test("groups into Built-in then Org, in that order", () => {
    const options = buildAgentOptions(fixture)
    const categories = [...new Set(options.map((o) => o.category))]
    expect(categories).toEqual(["Built-in", "Org"])
  })

  test("excludes hidden agents", () => {
    const options = buildAgentOptions(fixture)
    expect(options.some((o) => o.name === "secret-agent")).toBe(false)
  })

  test("every non-hidden org agent (including subagents) appears in the Org group with its displayName title", () => {
    const options = buildAgentOptions(fixture)
    const org = options.filter((o) => o.category === "Org")
    const names = org.map((o) => o.name)
    expect(names).toContain("ceo")
    expect(names).toContain("analyst")
    expect(names).toContain("swiftui-dev-1")

    expect(org.find((o) => o.name === "ceo")?.title).toBe("CEO")
    expect(org.find((o) => o.name === "analyst")?.title).toBe("Analyst")
  })

  test("the CEO (primary, source: organization) appears under Org, not Built-in", () => {
    const options = buildAgentOptions(fixture)
    const ceo = options.find((o) => o.name === "ceo")
    expect(ceo?.category).toBe("Org")
  })

  test("built-ins (no source) land in Built-in with titlecased fallback titles", () => {
    const options = buildAgentOptions(fixture)
    const builtin = options.filter((o) => o.category === "Built-in")
    expect(builtin.map((o) => o.name)).toEqual(["code", "plan", "ask"])
    expect(builtin.every((o) => o.title.length > 0)).toBe(true)
  })

  test("an org agent without displayName falls back to a titlecased name", () => {
    const options = buildAgentOptions(fixture)
    const worker = options.find((o) => o.name === "swiftui-dev-1")
    expect(worker?.title).toBe("Swiftui-Dev-1")
  })

  test("total option count excludes only the hidden agent", () => {
    const options = buildAgentOptions(fixture)
    expect(options).toHaveLength(fixture.length - 1)
  })
})
