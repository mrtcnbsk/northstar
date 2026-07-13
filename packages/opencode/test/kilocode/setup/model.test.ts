import { describe, expect, test } from "bun:test"
import { SetupModel } from "../../../src/kilocode/setup/model"

function fixture(): SetupModel.Draft {
  return {
    id: "product-studio",
    name: "Product Studio",
    step: "review",
    layers: {
      executive: { name: "Executive", mission: "Set direction" },
      leads: { name: "Department Leads", mission: "Coordinate departments" },
      specialists: { name: "Specialists", mission: "Produce verified work" },
    },
    departments: [
      {
        id: "engineering",
        name: "Engineering",
        mission: "Build verified software",
        chief: "lead",
        workers: ["engineer"],
      },
    ],
    agents: [
      {
        id: "ceo",
        name: "CEO",
        layer: "executive",
        role: "Own product direction",
        do: ["Approve measurable plans"],
        dont: ["Implement specialist work"],
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        permission: { edit: "ask" },
        subordinates: ["lead"],
      },
      {
        id: "lead",
        name: "Engineering Lead",
        layer: "leads",
        departmentID: "engineering",
        role: "Coordinate engineering",
        do: ["Delegate scoped work"],
        dont: ["Ship without evidence"],
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
        permission: {},
        subordinates: ["engineer"],
      },
      {
        id: "engineer",
        name: "Engineer",
        layer: "specialists",
        departmentID: "engineering",
        role: "Implement software",
        do: ["Run tests"],
        dont: ["Change product scope"],
        providerID: "openai",
        modelID: "gpt-5.1-codex",
        permission: { bash: "ask" },
        subordinates: [],
      },
    ],
    knowledge: [],
    pipeline: [{ stage: "engineering" }],
  }
}

describe("SetupModel", () => {
  test("serializes fixed layers and structured agent behavior", () => {
    const draft = fixture()
    const organization = SetupModel.organization(draft)
    expect(organization.name).toBe("Product Studio")
    expect(organization.layers).toEqual(draft.layers)
    expect(organization.departments.engineering).toMatchObject({
      name: "Engineering",
      mission: "Build verified software",
      chief: "lead",
      workers: ["engineer"],
    })
    expect(organization.pipeline[0]).toMatchObject({ stage: "engineering", gate: "human" })

    const agent = SetupModel.agent(draft.agents[0])
    expect(agent).toContain('displayName: "CEO"')
    expect(agent).toContain('model: "anthropic/claude-sonnet-4-5"')
    expect(agent).toContain("# Role\n\nOwn product direction")
    expect(agent).toContain("# Do\n\n- Approve measurable plans")
    expect(agent).toContain("# Don't\n\n- Implement specialist work")
  })

  test("creates an English five-step blank draft", () => {
    const draft = SetupModel.blank("New organization")
    expect(draft.step).toBe("organization")
    expect(draft.layers).toEqual({
      executive: { name: "Executive", mission: "Set organization direction and approve plans." },
      leads: { name: "Department Leads", mission: "Coordinate departments and verify outcomes." },
      specialists: { name: "Specialists", mission: "Produce focused, evidence-backed work." },
    })
  })

  test("reports hierarchy errors before publication", () => {
    const draft = fixture()
    draft.agents = draft.agents.filter((agent) => agent.id !== "ceo")
    draft.departments[0]!.chief = "missing"
    expect(SetupModel.issues(draft)).toEqual(
      expect.arrayContaining([expect.stringContaining("exactly one Executive"), expect.stringContaining("missing")]),
    )
  })

  test("tracks managed knowledge import state per selected file", () => {
    const draft = fixture()
    draft.knowledge = [
      {
        sources: ["brief.md", "spec.md"],
        scope: { type: "department", departmentID: "engineering" },
        status: { "brief.md": "indexed", "spec.md": "pending" },
      },
    ]
    expect(SetupModel.Draft.parse(draft).knowledge[0]?.status).toEqual({
      "brief.md": "indexed",
      "spec.md": "pending",
    })
  })

  test("keeps a department draft resumable before its lead is assigned", () => {
    const draft = SetupModel.blank("Product Studio")
    draft.departments = [
      { id: "engineering", name: "Engineering", mission: "Build verified software", chief: "", workers: [] },
    ]
    draft.pipeline = [{ stage: "engineering" }]
    expect(SetupModel.Draft.parse(draft).departments[0]?.chief).toBe("")
    expect(SetupModel.issues(draft)).toContain("Department 'engineering' has no assigned chief")
  })
})
