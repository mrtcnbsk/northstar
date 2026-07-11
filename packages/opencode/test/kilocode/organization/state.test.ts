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

describe("OrgState readiness selectors", () => {
  const LINEAR = OrgSchema.parse({
    ceo: "ceo",
    departments: {
      a: { chief: "a-chief", workers: ["a-worker"] },
      b: { chief: "b-chief", workers: ["b-worker"] },
      c: { chief: "c-chief", workers: ["c-worker"] },
    },
    pipeline: [{ stage: "a" }, { stage: "b" }, { stage: "c" }],
  })

  const DIAMOND = OrgSchema.parse({
    ceo: "ceo",
    departments: {
      plan: { chief: "plan-chief", workers: ["plan-worker"] },
      frontend: { chief: "frontend-chief", workers: ["frontend-worker"] },
      backend: { chief: "backend-chief", workers: ["backend-worker"] },
      integrate: { chief: "integrate-chief", workers: ["integrate-worker"] },
    },
    pipeline: [
      { stage: "plan" },
      { stage: "frontend", requires: ["plan"] },
      { stage: "backend", requires: ["plan"] },
      { stage: "integrate", requires: ["frontend", "backend"] },
    ],
  })

  function stage(status: OrgState.StageStatus): OrgState.Stage {
    return { status, attempts: 0 }
  }

  function runOf(org: OrgSchema.Organization, statuses: Record<string, OrgState.StageStatus>): OrgState.Run {
    return {
      runID: "test-run",
      idea: "test",
      createdAt: new Date().toISOString(),
      status: "active",
      stages: Object.fromEntries(org.pipeline.map((p) => [p.stage, stage(statuses[p.stage] ?? "pending")])),
    }
  }

  describe("linear pipeline (no requires)", () => {
    test("only the first stage is ready initially", () => {
      const run = runOf(LINEAR, {})
      expect(OrgState.readyStages(LINEAR, run)).toEqual(["a"])
      expect(OrgState.blockedStages(LINEAR, run)).toEqual(["b", "c"])
    })

    test("only the next stage is ready once the prior one completes", () => {
      const run = runOf(LINEAR, { a: "completed" })
      expect(OrgState.readyStages(LINEAR, run)).toEqual(["b"])
      expect(OrgState.blockedStages(LINEAR, run)).toEqual(["c"])
    })
  })

  describe("diamond pipeline (explicit requires)", () => {
    test("readyStages after plan completes is [frontend, backend] (both, pipeline order)", () => {
      const run = runOf(DIAMOND, { plan: "completed" })
      expect(OrgState.readyStages(DIAMOND, run)).toEqual(["frontend", "backend"])
    })

    test("integrate is blocked while only one of its two requirements is completed", () => {
      const run = runOf(DIAMOND, { plan: "completed", frontend: "completed", backend: "running" })
      expect(OrgState.readyStages(DIAMOND, run)).toEqual([])
      expect(OrgState.blockedStages(DIAMOND, run)).toEqual(["integrate"])
    })

    test("integrate becomes ready once both frontend and backend are completed", () => {
      const run = runOf(DIAMOND, { plan: "completed", frontend: "completed", backend: "completed" })
      expect(OrgState.readyStages(DIAMOND, run)).toEqual(["integrate"])
      expect(OrgState.blockedStages(DIAMOND, run)).toEqual([])
    })

    test("a skipped dependency satisfies its dependents just like completed", () => {
      const run = runOf(DIAMOND, { plan: "completed", frontend: "skipped", backend: "completed" })
      expect(OrgState.readyStages(DIAMOND, run)).toEqual(["integrate"])
      expect(OrgState.blockedStages(DIAMOND, run)).toEqual([])
    })
  })

  describe("blockedStages", () => {
    test("a pending stage whose requirement is still running is blocked, not ready", () => {
      const run = runOf(LINEAR, { a: "running" })
      expect(OrgState.readyStages(LINEAR, run)).toEqual([])
      expect(OrgState.blockedStages(LINEAR, run)).toEqual(["b", "c"])
    })
  })

  describe("runningStages / awaitingStages", () => {
    test("runningStages returns exactly the running stage names in pipeline order", () => {
      const run = runOf(DIAMOND, { plan: "completed", frontend: "running", backend: "running" })
      expect(OrgState.runningStages(DIAMOND, run)).toEqual(["frontend", "backend"])
    })

    test("awaitingStages returns exactly the awaiting_approval stage names in pipeline order", () => {
      const run = runOf(DIAMOND, { plan: "completed", frontend: "awaiting_approval", backend: "running" })
      expect(OrgState.awaitingStages(DIAMOND, run)).toEqual(["frontend"])
    })

    test("both return [] when no stage matches", () => {
      const run = runOf(LINEAR, {})
      expect(OrgState.runningStages(LINEAR, run)).toEqual([])
      expect(OrgState.awaitingStages(LINEAR, run)).toEqual([])
    })
  })
})
