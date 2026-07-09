import { describe, test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

describe("OrgState", () => {
  test("create initializes all stages pending and persists", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "a habit tracker for sailors")
    expect(run.runID).toMatch(/^\d{8}-\d{6}-/)
    expect(run.status).toBe("active")
    expect(run.stages["evaluation"].status).toBe("pending")
    expect(run.stages["planning"].status).toBe("pending")

    const loaded = await OrgState.read(tmp.path, run.runID)
    expect(loaded).toEqual(run)
  })

  test("update mutates and persists atomically", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "idea")
    const updated = await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].taskID = "ses_123"
    })
    expect(updated.stages["evaluation"].status).toBe("running")
    const loaded = await OrgState.read(tmp.path, run.runID)
    expect(loaded.stages["evaluation"].taskID).toBe("ses_123")
  })

  test("read throws a readable error for unknown run", async () => {
    await using tmp = await tmpdir()
    await expect(OrgState.read(tmp.path, "nope")).rejects.toThrow(/nope/)
  })

  test("list returns run ids, newest first", async () => {
    await using tmp = await tmpdir()
    const a = await OrgState.create(tmp.path, ORG, "first")
    await new Promise((r) => setTimeout(r, 1100)) // runID has second granularity
    const b = await OrgState.create(tmp.path, ORG, "second")
    const ids = await OrgState.list(tmp.path)
    expect(ids[0]).toBe(b.runID)
    expect(ids).toContain(a.runID)
  })

  test("slugifies the idea into the runID", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "Deniz Feneri! App (v2)")
    expect(run.runID).toMatch(/deniz-feneri-app-v2/)
  })

  test("slug cut at 40 chars does not end in a dash", () => {
    const slug = OrgState.slugify("a".repeat(39) + " tail beyond the cut")
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith("-")).toBe(false)
    expect(slug).toBe("a".repeat(39))
  })
})
