/** @jsxImportSource @opentui/solid */
// kilocode_change - Northstar Setup workflow integration
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { testRender } from "@opentui/solid"
import { createSetupWorkflow, type SetupWorkflowAPI } from "../../../src/kilocode/setup/view"
import type { SetupModel } from "../../../src/kilocode/setup/model"
import { OrganizationStep } from "../../../src/kilocode/setup/organization-step"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

let rendered: Awaited<ReturnType<typeof testRender>> | undefined
beforeAll(async () => {
  await mkdir(Global.Path.state, { recursive: true })
  await Bun.write(`${Global.Path.state}/kv.json`, "{}")
})
afterEach(() => {
  rendered?.renderer.destroy()
  rendered = undefined
})

function fixture(): SetupModel.Draft {
  return {
    id: "product-studio",
    name: "Product Studio",
    step: "organization",
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

function harness() {
  const calls: string[] = []
  const saved: SetupModel.Draft[] = []
  const api: SetupWorkflowAPI = {
    async stage(name) {
      calls.push(`stage:${name}`)
      return { id: "product-studio" }
    },
    async saveDraft(id, draft, definition) {
      calls.push(`save:${id}:${draft.step}:${definition ? "definition" : "draft"}`)
      saved.push(structuredClone(draft))
    },
    async importKnowledge(id, sources, scope) {
      calls.push(`import:${id}:${scope.type}:${sources.join(",")}`)
      return sources.map((source) => ({ source, status: "indexed" as const }))
    },
    async publish(id) {
      calls.push(`publish:${id}`)
    },
    async update(id, draft) {
      calls.push(`update:${id}:${draft.name}`)
    },
    async refresh() {
      calls.push("refresh")
    },
  }
  return { api, calls, saved }
}

describe("Setup workflow", () => {
  test("persists every step, imports in one action, and publishes atomically", async () => {
    const { api, calls, saved } = harness()
    const workflow = createSetupWorkflow({ api, draft: fixture() })

    await workflow.go("departments")
    await workflow.go("agents")
    await workflow.go("knowledge")
    await workflow.importFiles(["brief.md"], { type: "department", departmentID: "engineering" })
    await workflow.go("review")
    await workflow.finish()

    expect(saved.map((draft) => draft.step)).toEqual([
      "departments",
      "agents",
      "knowledge",
      "knowledge",
      "knowledge",
      "review",
      "review",
    ])
    expect(workflow.draft().knowledge[0]?.status).toEqual({ "brief.md": "indexed" })
    expect(calls.at(-3)).toBe("save:product-studio:review:definition")
    expect(calls.at(-2)).toBe("publish:product-studio")
    expect(calls.at(-1)).toBe("refresh")
  })

  test("resumes a staged draft and updates a published organization without restaging", async () => {
    const { api, calls } = harness()
    const draft = fixture()
    draft.step = "agents"
    const resumed = createSetupWorkflow({ api, draft, organizationID: "product-studio", mode: "edit" })
    expect(resumed.draft().step).toBe("agents")

    resumed.replace({ ...resumed.draft(), name: "Product Studio 2" })
    await resumed.finish()

    expect(calls).toEqual(["update:product-studio:Product Studio 2", "refresh"])
  })

  test("matches a normalized managed path back to the user-selected knowledge file", async () => {
    const { api } = harness()
    api.importKnowledge = async () => [{ source: "brief.md", status: "indexed" }]
    const workflow = createSetupWorkflow({ api, draft: fixture() })

    await workflow.importFiles(["/project/brief.md"], { type: "department", departmentID: "engineering" })

    expect(workflow.draft().knowledge[0]?.status).toEqual({ "/project/brief.md": "indexed" })
  })

  test("renders the first-run organization step in English with Northstar hierarchy copy", async () => {
    rendered = await testRender(
      () => (
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <OrganizationStep draft={fixture()} onEditName={() => {}} onEditLayer={() => {}} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      ),
      { width: 90, height: 20 },
    )
    const deadline = Date.now() + 5_000
    while (!rendered.captureCharFrame().includes("Create your organization")) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for Setup render")
      await rendered.renderOnce()
      await Bun.sleep(20)
    }
    const frame = rendered.captureCharFrame()
    expect(frame).toContain("Create your organization")
    expect(frame).toContain("Department Leads")
    expect(frame).not.toMatch(/Kilo Code|Kilo Gateway/)
  })
})
