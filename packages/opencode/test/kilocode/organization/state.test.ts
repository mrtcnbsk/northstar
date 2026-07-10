import { describe, test, expect } from "bun:test"
import path from "path"
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

  test("read rejects path-traversal runIDs instead of reading outside the runs dir", async () => {
    await using tmp = await tmpdir()
    // A real run-shaped file one level above runs/ (i.e. directly under .kilo/org/secret/state.json).
    // Without the guard, runDir(tmp, "../secret") resolves to exactly this path and read() would
    // successfully parse it -- proving the traversal actually escapes the runs directory.
    const secretRunDir = path.join(tmp.path, ".kilo", "org", "secret")
    await Bun.write(
      path.join(secretRunDir, "state.json"),
      JSON.stringify({
        runID: "secret",
        idea: "leaked",
        createdAt: new Date().toISOString(),
        status: "active",
        stages: {},
      }),
    )

    await expect(OrgState.read(tmp.path, "../secret")).rejects.toThrow(/Unknown org run/)
    await expect(OrgState.read(tmp.path, "../../etc")).rejects.toThrow(/Unknown org run/)
    await expect(OrgState.read(tmp.path, "foo/bar")).rejects.toThrow(/Unknown org run/)
    await expect(OrgState.read(tmp.path, "foo\\bar")).rejects.toThrow(/Unknown org run/)
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

  test("list returns [] when the runs directory does not exist at all", async () => {
    await using tmp = await tmpdir()
    const ids = await OrgState.list(tmp.path)
    expect(ids).toEqual([])
  })
})

describe("OrgState.stageCost", () => {
  test("sums multiple cost-map entries to the cent", () => {
    const stage: OrgState.Stage = {
      status: "completed",
      attempts: 1,
      costs: { ses_a: 1.23, ses_b: 4.56, ses_c: 0.01 },
    }
    expect(OrgState.stageCost(stage)).toBeCloseTo(5.8, 10)
  })

  test("falls back to legacy cost field when costs is absent", () => {
    const stage: OrgState.Stage = { status: "completed", attempts: 1, cost: 2.5 }
    expect(OrgState.stageCost(stage)).toBe(2.5)
  })

  test("falls back to legacy cost field when costs is an empty object", () => {
    const stage: OrgState.Stage = { status: "completed", attempts: 1, cost: 3, costs: {} }
    expect(OrgState.stageCost(stage)).toBe(3)
  })

  test("is 0 when neither costs nor legacy cost is present", () => {
    const stage: OrgState.Stage = { status: "pending", attempts: 0 }
    expect(OrgState.stageCost(stage)).toBe(0)
  })
})

describe("OrgState.runSummary", () => {
  test("totalCost sums across multiple stages, each with multiple cost-map entries", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "cost summing")
    const updated = await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "completed"
      s.stages["evaluation"].costs = { ses_1: 1.1, ses_2: 2.2 }
      s.stages["planning"].status = "running"
      s.stages["planning"].costs = { ses_3: 0.5, ses_4: 0.25, ses_5: 0.15 }
    })
    const summary = OrgState.runSummary(updated)
    expect(summary.totalCost).toBeCloseTo(1.1 + 2.2 + 0.5 + 0.25 + 0.15, 10)
  })

  test("awaitingGate is true when a stage is awaiting_approval", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "gate wait")
    const updated = await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "completed"
      s.stages["planning"].status = "awaiting_approval"
    })
    const summary = OrgState.runSummary(updated)
    expect(summary.awaitingGate).toBe(true)
    expect(summary.currentStage).toBe("planning")
  })

  test("awaitingGate is false when no stage is awaiting_approval", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "no gate wait")
    const updated = await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "completed"
      s.stages["planning"].status = "pending"
    })
    const summary = OrgState.runSummary(updated)
    expect(summary.awaitingGate).toBe(false)
  })

  test("currentStage is the running stage in pipeline order", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "current stage")
    const updated = await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "completed"
      s.stages["planning"].status = "running"
    })
    const summary = OrgState.runSummary(updated)
    expect(summary.currentStage).toBe("planning")
  })

  test("currentStage is null when no stage is running or awaiting_approval", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "idle stages")
    const summary = OrgState.runSummary(run)
    expect(summary.currentStage).toBeNull()
  })

  test("stageCount matches the number of stages", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "stage count")
    const summary = OrgState.runSummary(run)
    expect(summary.stageCount).toBe(2)
  })
})
