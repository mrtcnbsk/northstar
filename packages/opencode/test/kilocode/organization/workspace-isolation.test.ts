import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgMemory } from "../../../src/kilocode/organization/memory"
import { OrgPostmortem } from "../../../src/kilocode/organization/postmortem"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"

const ORGANIZATION = OrgSchema.parse({
  ceo: "ceo",
  departments: { work: { chief: "lead", workers: ["worker"] } },
  pipeline: [{ stage: "work" }],
})

async function published(dir: string, name: string) {
  const staged = await OrgWorkspace.stage(dir, name)
  return OrgWorkspace.publish(dir, staged.entry.id)
}

describe("organization workspace storage isolation", () => {
  test("runs, definitions, memory, and lessons stay inside their organization", async () => {
    await using tmp = await tmpdir()
    const alpha = await published(tmp.path, "Alpha")
    const beta = await published(tmp.path, "Beta")

    const alphaRun = await OrgWorkspace.run(alpha, async () => {
      await OrgSchema.writeOrganization(tmp.path, ORGANIZATION)
      await OrgMemory.save(tmp.path, { text: "alpha-only launch evidence" })
      return OrgState.create(tmp.path, ORGANIZATION, "same idea")
    })
    const betaRun = await OrgWorkspace.run(beta, async () => {
      await OrgSchema.writeOrganization(tmp.path, ORGANIZATION)
      await OrgMemory.save(tmp.path, { text: "beta-only research evidence" })
      return OrgState.create(tmp.path, ORGANIZATION, "same idea")
    })

    expect(alphaRun.organizationID).toBe("alpha")
    expect(betaRun.organizationID).toBe("beta")
    expect(await OrgWorkspace.run(alpha, () => OrgState.list(tmp.path))).toEqual([alphaRun.runID])
    expect(await OrgWorkspace.run(beta, () => OrgState.list(tmp.path))).toEqual([betaRun.runID])
    expect(await OrgWorkspace.run(alpha, () => OrgSchema.loadOrganization(tmp.path))).toEqual(ORGANIZATION)
    expect(await OrgWorkspace.run(beta, () => OrgSchema.loadOrganization(tmp.path))).toEqual(ORGANIZATION)
    expect(OrgWorkspace.run(alpha, () => OrgSchema.agentsPath(tmp.path))).toBe(alpha.paths.agents)
    expect(OrgWorkspace.run(beta, () => OrgSchema.agentsPath(tmp.path))).toBe(beta.paths.agents)

    const alphaRecall = await OrgWorkspace.run(alpha, () => OrgMemory.recall(tmp.path, { query: "evidence" }))
    const betaRecall = await OrgWorkspace.run(beta, () => OrgMemory.recall(tmp.path, { query: "evidence" }))
    expect(alphaRecall.hits.map((hit) => hit.text).join(" ")).toContain("alpha-only")
    expect(alphaRecall.hits.map((hit) => hit.text).join(" ")).not.toContain("beta-only")
    expect(betaRecall.hits.map((hit) => hit.text).join(" ")).toContain("beta-only")
    expect(betaRecall.hits.map((hit) => hit.text).join(" ")).not.toContain("alpha-only")

    expect(OrgWorkspace.run(alpha, () => OrgPostmortem.lessonsPath(tmp.path))).toBe(alpha.paths.lessons)
    expect(OrgWorkspace.run(beta, () => OrgPostmortem.lessonsPath(tmp.path))).toBe(beta.paths.lessons)
  })

  test("keeps legacy paths unchanged outside a managed scope", async () => {
    await using tmp = await tmpdir()

    expect(OrgSchema.organizationPath(tmp.path)).toBe(path.join(tmp.path, ".kilo", "organization.jsonc"))
    expect(OrgSchema.agentsPath(tmp.path)).toBe(path.join(tmp.path, ".kilo", "agent"))
    expect(OrgState.runsDir(tmp.path)).toBe(path.join(tmp.path, ".kilo", "org", "runs"))
    expect(OrgMemory.root(tmp.path)).toBe(path.join(tmp.path, ".kilo", "org", "memory"))
    expect(OrgPostmortem.lessonsPath(tmp.path)).toBe(path.join(tmp.path, ".kilo", "org", "lessons.md"))
  })
})
