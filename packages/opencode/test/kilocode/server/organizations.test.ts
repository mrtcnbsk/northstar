import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../../src/server/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"
import { OrganizationsHandler } from "../../../src/kilocode/server/httpapi/handlers/organizations"

void Log.init({ print: false })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function request(dir: string, input: string, init?: RequestInit) {
  return Server.Default().app.request(input, {
    ...init,
    headers: { "x-kilo-directory": dir, "content-type": "application/json", ...init?.headers },
  })
}

const ORGANIZATION = JSON.stringify({
  ceo: "ceo",
  departments: { engineering: { chief: "engineering-lead", workers: ["engineer"] } },
  pipeline: [{ stage: "engineering" }],
})

const AGENTS = [
  {
    id: "ceo",
    content: '---\nmode: "primary"\nsubordinates: ["engineering-lead"]\n---\n# Role\n\nSet direction.\n',
  },
  {
    id: "engineering-lead",
    content: '---\nmode: "subagent"\nsubordinates: ["engineer"]\n---\n# Role\n\nLead engineering.\n',
  },
  { id: "engineer", content: '---\nmode: "subagent"\n---\n# Role\n\nBuild software.\n' },
]

const SETUP_DRAFT = {
  id: "product-studio",
  name: "Product Studio",
  step: "review" as const,
  layers: {
    executive: { name: "Executive", mission: "Set direction" },
    leads: { name: "Department Leads", mission: "Coordinate engineering" },
    specialists: { name: "Specialists", mission: "Build verified software" },
  },
  departments: [
    {
      id: "engineering",
      name: "Engineering",
      mission: "Build verified software",
      chief: "engineering-lead",
      workers: ["engineer"],
    },
  ],
  agents: [
    {
      id: "ceo",
      name: "CEO",
      layer: "executive" as const,
      role: "Set direction",
      do: ["Approve plans"],
      dont: ["Implement specialist work"],
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      permission: {},
      subordinates: ["engineering-lead"],
    },
    {
      id: "engineering-lead",
      name: "Engineering Lead",
      layer: "leads" as const,
      departmentID: "engineering",
      role: "Lead engineering",
      do: ["Delegate work"],
      dont: ["Skip verification"],
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
      permission: {},
      subordinates: ["engineer"],
    },
    {
      id: "engineer",
      name: "Engineer",
      layer: "specialists" as const,
      departmentID: "engineering",
      role: "Build software",
      do: ["Run tests"],
      dont: ["Change scope"],
      providerID: "openai",
      modelID: "gpt-5.1-codex",
      permission: {},
      subordinates: [],
    },
  ],
  knowledge: [],
  pipeline: [{ stage: "engineering" }],
}

describe("OrganizationsHandler", () => {
  test("saves an incomplete Setup draft without publishing a runtime definition", async () => {
    await using tmp = await tmpdir()
    const staged = await OrganizationsHandler.stage(tmp.path, { name: "Product Studio" })
    const draft = { ...SETUP_DRAFT, step: "departments" as const, departments: [], agents: [], pipeline: [] }

    const saved = await OrganizationsHandler.saveDraft(tmp.path, {
      organizationID: staged.organization.id,
      draft,
    })

    expect(saved.draft).toEqual(draft)
    expect(saved.definition).toBeUndefined()
    expect(await Bun.file(staged.paths.organization).exists()).toBe(false)
  })

  test("stages, saves, publishes, lists, and selects organizations", async () => {
    await using tmp = await tmpdir()
    const product = await OrganizationsHandler.stage(tmp.path, { name: "Product Studio" })
    await OrganizationsHandler.saveDraft(tmp.path, {
      organizationID: product.organization.id,
      draft: SETUP_DRAFT,
      organization: ORGANIZATION,
      agents: AGENTS,
    })

    const saved = await OrganizationsHandler.get(tmp.path, product.organization.id)
    expect(saved.draft).toEqual(SETUP_DRAFT)
    expect(saved.agents.map((agent) => agent.id).sort()).toEqual(["ceo", "engineer", "engineering-lead"])
    expect(saved.valid).toBe(true)

    const published = await OrganizationsHandler.publish(tmp.path, product.organization.id)
    expect(published.active).toBe("product-studio")
    expect(published.organizations).toHaveLength(1)
    expect(published.organizations[0]).toMatchObject({ id: "product-studio", valid: true })

    const research = await OrganizationsHandler.stage(tmp.path, { name: "Research Team" })
    await OrganizationsHandler.saveDraft(tmp.path, {
      organizationID: research.organization.id,
      draft: { ...SETUP_DRAFT, id: "research-team", name: "Research Team" },
      organization: ORGANIZATION,
      agents: AGENTS,
    })
    await OrganizationsHandler.publish(tmp.path, research.organization.id)
    expect((await OrganizationsHandler.select(tmp.path, "product-studio")).active).toBe("product-studio")
  })

  test("fails closed when staged agents do not match the organization", async () => {
    await using tmp = await tmpdir()
    const staged = await OrganizationsHandler.stage(tmp.path, { name: "Broken" })

    await expect(
      OrganizationsHandler.saveDraft(tmp.path, {
        organizationID: staged.organization.id,
        draft: { ...SETUP_DRAFT, id: "broken", name: "Broken" },
        organization: ORGANIZATION,
        agents: AGENTS.filter((agent) => agent.id !== "engineer"),
      }),
    ).rejects.toThrow('agent "engineer"')
    expect(await Bun.file(path.join(staged.paths.root, "organization.jsonc")).exists()).toBe(false)
  })

  test("imports and searches staged managed knowledge", async () => {
    await using tmp = await tmpdir()
    const staged = await OrganizationsHandler.stage(tmp.path, { name: "Studio" })
    await Bun.write(path.join(tmp.path, "brief.md"), "acceptance evidence for launch")

    const imported = await OrganizationsHandler.importKnowledge(tmp.path, staged.organization.id, {
      sources: ["brief.md"],
      scope: { type: "department", departmentID: "engineering" },
    })
    const results = await OrganizationsHandler.searchKnowledge(tmp.path, staged.organization.id, {
      query: "acceptance evidence",
      departmentID: "engineering",
    })

    expect(imported.files[0]?.status).toBe("indexed")
    expect(results).toHaveLength(1)
  })

  test("updates a published definition without replacing organization data", async () => {
    await using tmp = await tmpdir()
    const staged = await OrganizationsHandler.stage(tmp.path, { name: "Product Studio" })
    await OrganizationsHandler.saveDraft(tmp.path, {
      organizationID: staged.organization.id,
      draft: SETUP_DRAFT,
      organization: ORGANIZATION,
      agents: AGENTS,
    })
    await OrganizationsHandler.publish(tmp.path, staged.organization.id)
    const marker = path.join(tmp.path, ".kilo", "organizations", "product-studio", "knowledge", "keep.txt")
    await Bun.write(marker, "keep me")

    const updated = await OrganizationsHandler.update(tmp.path, {
      organizationID: "product-studio",
      name: "Product Studio 2",
      draft: { ...SETUP_DRAFT, name: "Product Studio 2" },
      organization: ORGANIZATION,
      agents: AGENTS,
    })

    expect(updated.organization.name).toBe("Product Studio 2")
    expect((await OrganizationsHandler.list(tmp.path)).organizations[0]?.name).toBe("Product Studio 2")
    expect(await Bun.file(marker).text()).toBe("keep me")
  })
})

describe("organization routes", () => {
  test("stages and lists a project-local organization draft", async () => {
    await using tmp = await tmpdir()

    const staged = await request(tmp.path, "/organizations/staging", {
      method: "POST",
      body: JSON.stringify({ name: "Product Studio" }),
    })
    expect(staged.status).toBe(200)
    expect(await staged.json()).toMatchObject({ organization: { id: "product-studio", name: "Product Studio" } })

    const listed = await request(tmp.path, "/organizations")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({ organizations: [], drafts: [{ id: "product-studio", draft: true }] })
  })

  test("saves, imports, publishes, selects, and discards through HTTP", async () => {
    await using tmp = await tmpdir()
    const staged = await request(tmp.path, "/organizations/staging", {
      method: "POST",
      body: JSON.stringify({ name: "Product Studio" }),
    })
    expect(staged.status).toBe(200)

    const saved = await request(tmp.path, "/organizations/staging/product-studio", {
      method: "PUT",
      body: JSON.stringify({
        draft: { ...SETUP_DRAFT, step: "knowledge" },
        organization: ORGANIZATION,
        agents: AGENTS,
      }),
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ valid: true, draft: { step: "knowledge" } })

    const detail = await request(tmp.path, "/organizations/product-studio")
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({ organization: { id: "product-studio" }, valid: true })

    await Bun.write(path.join(tmp.path, "brief.md"), "launch acceptance evidence")
    const imported = await request(tmp.path, "/organizations/product-studio/knowledge/import", {
      method: "POST",
      body: JSON.stringify({
        sources: ["brief.md"],
        scope: { type: "department", departmentID: "engineering" },
      }),
    })
    expect(imported.status).toBe(200)
    expect(await imported.json()).toMatchObject({ files: [{ status: "indexed" }] })

    const searched = await request(tmp.path, "/organizations/product-studio/knowledge/search", {
      method: "POST",
      body: JSON.stringify({ query: "acceptance evidence", departmentID: "engineering" }),
    })
    expect(searched.status).toBe(200)
    expect((await searched.json()) as unknown[]).toHaveLength(1)

    const published = await request(tmp.path, "/organizations/product-studio/publish", { method: "POST" })
    expect(published.status).toBe(200)
    expect(await published.json()).toMatchObject({ active: "product-studio", organizations: [{ valid: true }] })

    const updated = await request(tmp.path, "/organizations/product-studio", {
      method: "PUT",
      body: JSON.stringify({
        name: "Product Studio 2",
        draft: { ...SETUP_DRAFT, name: "Product Studio 2" },
        organization: ORGANIZATION,
        agents: AGENTS,
      }),
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ organization: { id: "product-studio", name: "Product Studio 2" } })

    await request(tmp.path, "/organizations/staging", {
      method: "POST",
      body: JSON.stringify({ name: "Temporary" }),
    })
    const discarded = await request(tmp.path, "/organizations/staging/temporary", { method: "DELETE" })
    expect(discarded.status).toBe(200)
    expect(await discarded.json()).toMatchObject({ drafts: [] })

    const selected = await request(tmp.path, "/organizations/product-studio/select", { method: "POST" })
    expect(selected.status).toBe(200)
    expect(await selected.json()).toMatchObject({ active: "product-studio" })
  })
})
