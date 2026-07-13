/** @jsxImportSource @opentui/solid */
// kilocode_change - end-to-end Northstar workspace journey
import { expect, test } from "bun:test"
import path from "node:path"
import { readdir, readFile } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { SetupModel } from "../../../src/kilocode/setup/model"
import { createSetupWorkflow, type SetupWorkflowAPI } from "../../../src/kilocode/setup/view"
import { OrganizationsHandler } from "../../../src/kilocode/server/httpapi/handlers/organizations"
import { decideWorkspaceRoute } from "../../../src/kilocode/workspace/bootstrap"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgDriver } from "../../../src/kilocode/organization/driver"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgKnowledge } from "../../../src/kilocode/organization/knowledge"
import { OrgRunsView } from "../../../src/kilocode/server/httpapi/handlers/org-runs"
import { missionCompletion } from "../../../src/kilocode/cockpit/conversation"
import { KiloSession } from "../../../src/kilocode/session"

function organizationDraft(name: string): SetupModel.Draft {
  const draft = SetupModel.blank(name)
  draft.departments = [
    {
      id: "plan",
      name: "Planning",
      mission: "Turn briefs into verified plans",
      chief: "plan-chief",
      workers: ["planner"],
    },
    {
      id: "delivery",
      name: "Delivery",
      mission: "Produce the approved result",
      chief: "delivery-chief",
      workers: ["specialist"],
    },
  ]
  draft.agents = [
    {
      id: "ceo",
      name: "CEO",
      layer: "executive",
      role: "Own the mission and approve measurable plans",
      do: ["Delegate through department leads"],
      dont: ["Perform specialist work directly"],
      providerID: "openai",
      modelID: "gpt-5",
      permission: {},
      subordinates: ["plan-chief", "delivery-chief"],
    },
    {
      id: "plan-chief",
      name: "Planning Lead",
      layer: "leads",
      departmentID: "plan",
      role: "Coordinate planning evidence",
      do: ["Assign focused research"],
      dont: ["Approve the CEO plan"],
      providerID: "openai",
      modelID: "gpt-5",
      permission: {},
      subordinates: ["planner"],
    },
    {
      id: "delivery-chief",
      name: "Delivery Lead",
      layer: "leads",
      departmentID: "delivery",
      role: "Coordinate verified delivery",
      do: ["Require completion evidence"],
      dont: ["Skip acceptance criteria"],
      providerID: "openai",
      modelID: "gpt-5",
      permission: {},
      subordinates: ["specialist"],
    },
    {
      id: "planner",
      name: "Planner",
      layer: "specialists",
      departmentID: "plan",
      role: "Produce an evidence-backed plan",
      do: ["Cite managed knowledge"],
      dont: ["Change the mission scope"],
      providerID: "openai",
      modelID: "gpt-5",
      permission: {},
      subordinates: [],
    },
    {
      id: "specialist",
      name: "Delivery Specialist",
      layer: "specialists",
      departmentID: "delivery",
      role: "Produce the requested deliverable",
      do: ["Run focused verification"],
      dont: ["Ship without evidence"],
      providerID: "openai",
      modelID: "gpt-5",
      permission: {},
      subordinates: [],
    },
  ]
  draft.pipeline = [{ stage: "plan" }, { stage: "delivery" }]
  return draft
}

function setupAPI(projectDir: string): SetupWorkflowAPI {
  return {
    async stage(name) {
      const result = await OrganizationsHandler.stage(projectDir, { name })
      return { id: result.organization.id }
    },
    async saveDraft(organizationID, draft, definition) {
      await OrganizationsHandler.saveDraft(projectDir, {
        organizationID,
        draft,
        organization: definition?.organization,
        agents: definition?.agents,
      })
    },
    async importKnowledge(organizationID, sources, scope) {
      const result = await OrganizationsHandler.importKnowledge(projectDir, organizationID, { sources, scope })
      return result.files.map((file) => ({ source: file.source, status: file.status }))
    },
    async publish(organizationID) {
      await OrganizationsHandler.publish(projectDir, organizationID)
    },
    async update(organizationID, draft, definition) {
      await OrganizationsHandler.update(projectDir, { organizationID, name: draft.name, draft, ...definition })
    },
    async refresh() {},
  }
}

async function createOrganization(projectDir: string, draft: SetupModel.Draft, knowledge: string) {
  const workflow = createSetupWorkflow({ api: setupAPI(projectDir), draft })
  await workflow.go("departments")
  await workflow.go("agents")
  await workflow.go("knowledge")
  await workflow.importFiles([knowledge], { type: "department", departmentID: "plan" })
  await workflow.go("review")
  await workflow.finish()
  return workflow.organizationID()!
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true })
  return entries
    .map(String)
    .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
    .map((file) => path.join(root, file))
}

test("first launch creates, switches, chats, and completes without legacy branding", async () => {
  await using tmp = await tmpdir()
  const empty = await OrganizationsHandler.list(tmp.path)
  expect(decideWorkspaceRoute(empty)).toEqual({ type: "setup" })

  const productKnowledge = path.join(tmp.path, "product-brief.md")
  const researchKnowledge = path.join(tmp.path, "research-brief.md")
  await Bun.write(productKnowledge, "Product evidence and onboarding requirements.")
  await Bun.write(researchKnowledge, "Research evidence and source-quality requirements.")
  const productID = await createOrganization(tmp.path, organizationDraft("Product Studio"), productKnowledge)
  const researchID = await createOrganization(tmp.path, organizationDraft("Research Lab"), researchKnowledge)
  expect(productID).toBe("product-studio")
  expect(researchID).toBe("research-lab")

  const selected = await OrganizationsHandler.select(tmp.path, productID)
  expect(decideWorkspaceRoute(selected)).toEqual({ type: "cockpit" })
  const product = await OrgWorkspace.resolve(tmp.path, productID)
  expect(
    (await OrganizationsHandler.searchKnowledge(tmp.path, productID, { query: "onboarding", departmentID: "plan" }))
      .length,
  ).toBeGreaterThan(0)
  expect((await OrgKnowledge.manifest(product)).items[0]?.managed).toStartWith("departments/plan/")

  const chat = KiloSession.forOrganization(
    [
      { id: "ses_product", metadata: { northstarOrganizationID: productID } },
      { id: "ses_research", metadata: { northstarOrganizationID: researchID } },
    ],
    productID,
    false,
  )
  expect(chat.map((session) => session.id)).toEqual(["ses_product"])

  const detail = await OrgWorkspace.run(product, async () => {
    const organization = await OrgSchema.loadOrganization(tmp.path)
    const run = await OrgRunner.start(tmp.path, organization, "Ship the onboarding workspace", undefined, "ses_product")
    const deps = { costOf: async () => 0 }
    await OrgRunner.advance(deps, tmp.path, organization, run.runID, {})
    await Bun.write(OrgArtifacts.deliverablePath(tmp.path, run.runID, "plan"), `plan ${"evidence ".repeat(24)}`)
    await OrgRunner.advance(deps, tmp.path, organization, run.runID, { taskID: "ses_plan" })
    await OrgRunner.commitPlan(
      tmp.path,
      organization,
      run.runID,
      organization.pipeline.map(({ stage }) => ({
        stage,
        objective: `Complete ${stage}`,
        criteria: [`${stage} evidence is explicit`],
        agents: organization.departments[stage]!.workers,
      })),
    )
    const approved = await OrgRunner.decide(tmp.path, organization, run.runID, "approve", undefined, "plan")
    expect(approved.auto).toBe(true)
    const outcome = await OrgDriver.attach({
      projectDir: tmp.path,
      organization: product,
      org: organization,
      runID: run.runID,
      runtime: {
        costOf: async () => 1,
        spawnChief: async ({ runID, stage }) => {
          await Bun.write(
            OrgArtifacts.deliverablePath(tmp.path, runID, stage),
            `${stage} ${"verified evidence ".repeat(16)}`,
          )
          return { taskID: `ses_${stage}`, cost: 1, toolIDs: [] }
        },
        evaluate: async () => '{"pass":true,"summary":"all criteria evidenced"}',
      },
    })
    expect(outcome).toEqual({ type: "completed" })
    return OrgRunsView.detail(tmp.path, run.runID)
  })
  const completed = missionCompletion(detail)
  expect(completed?.title).toBe("Mission complete")
  expect(completed?.deliverables.map((item) => item.stage)).toEqual(["plan", "delivery"])
  expect(completed?.action).toBe("Return to Chat")

  const roots = [
    path.join(import.meta.dir, "../../../src/kilocode/setup"),
    path.join(import.meta.dir, "../../../src/kilocode/workspace"),
    path.join(import.meta.dir, "../../../src/kilocode/cockpit"),
  ]
  const files = (await Promise.all(roots.map(sourceFiles))).flat()
  const visibleSource = (await Promise.all(files.map((file) => readFile(file, "utf8"))))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  expect(visibleSource).not.toMatch(/Kilo Code|Kilo Gateway|kilo upgrade/i)
  expect(visibleSource).not.toMatch(/final kapı|revize|görev|organizasyon|tamamlandı/i)
})
