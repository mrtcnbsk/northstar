// kilocode_change - new file
// W8.7: fixture-org benchmark harness. OrgBenchmark drives the EXISTING deterministic OrgRunner
// with a scripted per-stage cost table (no LLM) - it does NOT reimplement any pipeline logic, only
// the drive loop (write deliverable on instruct, auto-decide on gate) that tools.ts's CEO tool
// would otherwise perform via the LLM. Mirrors schema.test.ts's parse/validate/load assertion
// style and runner.test.ts's writeDeliverable/tmpdir idioms.
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgBenchmark } from "../../../src/kilocode/organization/benchmark"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"

const LINEAR_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "evaluation" }, { stage: "planning" }],
})

const GATED_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

const DIAMOND_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    frontend: { chief: "fe-chief", workers: ["ui"] },
    backend: { chief: "be-chief", workers: ["api"] },
    integrate: { chief: "int-chief", workers: ["qa"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "plan" },
    { stage: "frontend", requires: ["plan"] },
    { stage: "backend", requires: ["plan"] },
    { stage: "integrate", requires: ["frontend", "backend"] },
  ],
  maxConcurrency: 2,
})

const VALID_BENCH = {
  org: LINEAR_ORG,
  idea: "a benchmark fixture idea",
  costs: { evaluation: 1, planning: 2 },
  sla: { maxCost: 10 },
}

describe("OrgBenchmark.parse + validate", () => {
  test("accepts a valid benchmark", () => {
    const bench = OrgBenchmark.parse(VALID_BENCH)
    expect(OrgBenchmark.validate(bench)).toEqual([])
  })

  test("rejects a benchmark referencing an unknown stage in costs", () => {
    const bench = OrgBenchmark.parse({ ...VALID_BENCH, costs: { ...VALID_BENCH.costs, ghost: 5 } })
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.includes("costs") && e.includes("ghost"))).toBe(true)
  })

  test("rejects a benchmark referencing an unknown stage in decisions", () => {
    const bench = OrgBenchmark.parse({ ...VALID_BENCH, decisions: { ghost: "approve" } })
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.includes("decisions") && e.includes("ghost"))).toBe(true)
  })

  test("rejects a benchmark referencing an unknown stage in sla.deliverables", () => {
    const bench = OrgBenchmark.parse({ ...VALID_BENCH, sla: { ...VALID_BENCH.sla, deliverables: ["ghost"] } })
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.includes("sla.deliverables") && e.includes("ghost"))).toBe(true)
  })

  test("rejects a benchmark missing sla entirely", () => {
    const { sla: _sla, ...withoutSla } = VALID_BENCH
    const bench = OrgBenchmark.parse(withoutSla)
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.toLowerCase().includes("sla"))).toBe(true)
  })

  test("rejects a benchmark with neither org nor orgPath", () => {
    const { org: _org, ...withoutOrg } = VALID_BENCH
    const bench = OrgBenchmark.parse(withoutOrg)
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.includes("org"))).toBe(true)
  })

  test("rejects a benchmark with both org and orgPath", () => {
    const bench = OrgBenchmark.parse({ ...VALID_BENCH, orgPath: "./organization.jsonc" })
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.includes("only one of"))).toBe(true)
  })

  test("surfaces the inline org's own structural errors too (duplicate pipeline stage)", () => {
    const brokenOrg = { ...LINEAR_ORG, pipeline: [LINEAR_ORG.pipeline[0], LINEAR_ORG.pipeline[0]] }
    const bench = OrgBenchmark.parse({ ...VALID_BENCH, org: brokenOrg })
    const errors = OrgBenchmark.validate(bench)
    expect(errors.some((e) => e.includes("duplicate"))).toBe(true)
  })
})

describe("OrgBenchmark.loadBenchmark", () => {
  test("loads a benchmark.jsonc with comments and trailing commas", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "benchmark.jsonc")
    await Bun.write(
      file,
      `// a fixture benchmark\n${JSON.stringify(VALID_BENCH, null, 2).replace(/}$/, "  // trailing\n}")}`,
    )
    const bench = await OrgBenchmark.loadBenchmark(file)
    expect(bench.idea).toBe("a benchmark fixture idea")
    expect(bench.costs).toEqual({ evaluation: 1, planning: 2 })
  })

  test("throws a readable error when the file is missing", async () => {
    await using tmp = await tmpdir()
    await expect(OrgBenchmark.loadBenchmark(path.join(tmp.path, "nope.jsonc"))).rejects.toThrow()
  })

  test("throws readably when validate() finds errors (missing sla)", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "benchmark.jsonc")
    const { sla: _sla, ...withoutSla } = VALID_BENCH
    await Bun.write(file, JSON.stringify(withoutSla))
    await expect(OrgBenchmark.loadBenchmark(file)).rejects.toThrow(/sla/i)
  })

  test("wraps zod schema errors readably instead of raw zod JSON", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "benchmark.jsonc")
    await Bun.write(file, JSON.stringify({ idea: "x" }))
    const err = await OrgBenchmark.loadBenchmark(file).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).not.toContain('"code":"invalid_type"')
  })
})

describe("OrgBenchmark.runBenchmark - drives the existing OrgRunner", () => {
  test("linear 2-stage fixture runs to completion deterministically with scripted costs", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: LINEAR_ORG,
      idea: "linear benchmark idea",
      costs: { evaluation: 3, planning: 4 },
      sla: { maxCost: 100 },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)

    expect(result.status).toBe("completed")
    expect(result.totalCost).toBe(7)
    expect(result.deliverablesProduced).toEqual(["evaluation", "planning"])
    expect(result.perStageAttempts).toEqual({ evaluation: 1, planning: 1 })
    expect(result.stageCount).toBe(2)
    expect(result.slaViolations).toEqual([])

    // proves it drove the REAL OrgRunner (state.json persisted under .kilo/org/runs, not reimplemented)
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.status).toBe("completed")
    expect(state.stages["evaluation"].status).toBe("completed")
    expect(state.stages["planning"].status).toBe("completed")
  })

  test("gated fixture auto-approves by default and proceeds", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "gated benchmark idea",
      costs: { evaluation: 1, planning: 1 },
      sla: {},
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.status).toBe("completed")
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.stages["evaluation"].decision).toBe("approve")
  })

  test("a scripted no-go decision halts the run and the downstream stage never runs", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "no-go benchmark idea",
      costs: { evaluation: 1, planning: 1 },
      decisions: { evaluation: "no-go" },
      sla: {},
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.status).toBe("halted")
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.stages["planning"].status).toBe("pending")
  })

  test("a scripted revise decision fires exactly once (attempts bump to 2) then auto-approves to terminate", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "revise benchmark idea",
      costs: { evaluation: 1, planning: 1 },
      decisions: { evaluation: "revise" },
      sla: {},
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.status).toBe("completed")
    expect(result.perStageAttempts["evaluation"]).toBe(2)
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.stages["evaluation"].decision).toBe("approve") // fell back to approve on the second gate
  })

  test("fan-out diamond org (maxConcurrency:2) drives via taskResults, no reimplemented pipeline logic", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: DIAMOND_ORG,
      idea: "diamond benchmark idea",
      costs: { plan: 1, frontend: 2, backend: 2, integrate: 1 },
      sla: { maxCost: 100 },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.status).toBe("completed")
    expect(result.totalCost).toBe(6)
    expect(result.deliverablesProduced.sort()).toEqual(["backend", "frontend", "integrate", "plan"])
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.stages["frontend"].status).toBe("completed")
    expect(state.stages["backend"].status).toBe("completed")
    expect(state.stages["integrate"].status).toBe("completed")
  })

  test("costOf reports the cumulative per-session cost keyed by stage, not a per-call delta", async () => {
    await using tmp = await tmpdir()
    // Same scripted cost every settle call for a stage's session - proves costOf's cumulative
    // semantics (a resumed session overwrites its own key rather than summing per call).
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "cumulative cost idea",
      costs: { evaluation: 5, planning: 1 },
      decisions: { evaluation: "revise" }, // resumes the SAME session across the revise cycle
      sla: {},
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    // If cost were double-counted per settle call across the revise's two completions, evaluation's
    // stage total would be 10 (5+5); the correct cumulative/overwrite semantics keep it at 5.
    const state = await OrgState.read(tmp.path, result.runID)
    expect(OrgState.stageCost(state.stages["evaluation"])).toBe(5)
  })
})

describe("OrgBenchmark.evaluateSla (pure)", () => {
  const BASE_RESULT: OrgBenchmark.BenchmarkResult = {
    runID: "run-1",
    status: "completed",
    totalCost: 5,
    stageCount: 2,
    perStageAttempts: { evaluation: 1, planning: 1 },
    deliverablesProduced: ["evaluation", "planning"],
    slaViolations: [],
  }

  test("passes when every SLA goal is satisfied", () => {
    const violations = OrgBenchmark.evaluateSla(BASE_RESULT, {
      maxCost: 10,
      maxStages: 5,
      expectStatus: "completed",
      maxRetries: 3,
      deliverables: ["evaluation", "planning"],
    })
    expect(violations).toEqual([])
  })

  test("flags a maxCost violation", () => {
    const violations = OrgBenchmark.evaluateSla(BASE_RESULT, { maxCost: 1 })
    expect(violations.some((v) => v.includes("maxCost") || v.toLowerCase().includes("cost"))).toBe(true)
  })

  test("flags an expectStatus violation", () => {
    const violations = OrgBenchmark.evaluateSla(BASE_RESULT, { expectStatus: "halted" })
    expect(violations.some((v) => v.toLowerCase().includes("status"))).toBe(true)
  })

  test("flags a maxStages violation", () => {
    const violations = OrgBenchmark.evaluateSla(BASE_RESULT, { maxStages: 1 })
    expect(violations.some((v) => v.toLowerCase().includes("stage"))).toBe(true)
  })

  test("flags a maxRetries violation naming the offending stage", () => {
    const result: OrgBenchmark.BenchmarkResult = {
      ...BASE_RESULT,
      perStageAttempts: { evaluation: 3, planning: 1 },
    }
    const violations = OrgBenchmark.evaluateSla(result, { maxRetries: 1 })
    expect(violations.some((v) => v.includes("evaluation") && v.toLowerCase().includes("retr"))).toBe(true)
    expect(violations.some((v) => v.includes("planning"))).toBe(false)
  })

  test("flags a missing required deliverable", () => {
    const result: OrgBenchmark.BenchmarkResult = { ...BASE_RESULT, deliverablesProduced: ["evaluation"] }
    const violations = OrgBenchmark.evaluateSla(result, { deliverables: ["evaluation", "planning"] })
    expect(violations.some((v) => v.includes("planning"))).toBe(true)
  })

  test("an empty sla object never violates", () => {
    expect(OrgBenchmark.evaluateSla(BASE_RESULT, {})).toEqual([])
  })
})

describe("OrgBenchmark SLA regression - integration via runBenchmark", () => {
  test("maxCost SLA violation surfaces from a real run", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: LINEAR_ORG,
      idea: "over-budget idea",
      costs: { evaluation: 3, planning: 4 },
      sla: { maxCost: 5 },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.totalCost).toBe(7)
    expect(result.slaViolations.some((v) => v.toLowerCase().includes("cost"))).toBe(true)
  })

  test("expectStatus SLA violation surfaces when a scripted no-go halts an expected-to-complete run", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "expect-status idea",
      costs: { evaluation: 1, planning: 1 },
      decisions: { evaluation: "no-go" },
      sla: { expectStatus: "completed" },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.status).toBe("halted")
    expect(result.slaViolations.some((v) => v.toLowerCase().includes("status"))).toBe(true)
  })

  test("maxStages SLA violation surfaces from a real run that reaches more stages than allowed", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: LINEAR_ORG,
      idea: "too-many-stages idea",
      costs: { evaluation: 1, planning: 1 },
      sla: { maxStages: 1 },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.stageCount).toBe(2)
    expect(result.slaViolations.some((v) => v.toLowerCase().includes("stage"))).toBe(true)
  })

  test("maxRetries SLA violation surfaces when a scripted revise bumps a stage's attempts past the cap", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "retry-cap idea",
      costs: { evaluation: 1, planning: 1 },
      decisions: { evaluation: "revise" },
      sla: { maxRetries: 1 },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.perStageAttempts["evaluation"]).toBe(2)
    expect(result.slaViolations.some((v) => v.includes("evaluation"))).toBe(true)
  })

  test("missing-deliverable SLA violation surfaces when a no-go halt strands a downstream stage", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "stranded deliverable idea",
      costs: { evaluation: 1, planning: 1 },
      decisions: { evaluation: "no-go" },
      sla: { deliverables: ["evaluation", "planning"] },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.deliverablesProduced).toEqual(["evaluation"])
    expect(result.slaViolations.some((v) => v.includes("planning"))).toBe(true)
  })

  // The org's OWN budget ceiling is enforced POST-stage (see runner.ts settleRunningStage): a stage
  // that overshoots the ceiling still completes and records its real cost BEFORE the halt fires, so
  // the recorded totalCost can exceed the org's budget.run by that one stage's spend. This is
  // correct, documented runner behavior (not a bug) - evaluateSla must still flag it as a maxCost
  // violation against the benchmark's OWN sla.maxCost, proving the harness surfaces the overshoot
  // rather than silently tolerating it.
  test("post-stage budget-ceiling overshoot: org halts on its own budget AND the SLA still flags the cost overshoot", async () => {
    await using tmp = await tmpdir()
    const TIGHT_BUDGET_ORG = OrgSchema.parse({
      ...JSON.parse(JSON.stringify(LINEAR_ORG)),
      budget: { run: 5, stage: 100, escalationThreshold: 100, retries: 2 },
    })
    const bench = OrgBenchmark.parse({
      org: TIGHT_BUDGET_ORG,
      idea: "post-stage ceiling idea",
      costs: { evaluation: 8, planning: 1 }, // evaluation alone already overshoots budget.run=5
      sla: { maxCost: 5, expectStatus: "completed" },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)

    // the org's own ceiling halts the run, but only AFTER evaluation's cost (8) is recorded -
    // overshooting budget.run (5) by that one stage's spend, exactly as documented.
    expect(result.status).toBe("halted")
    expect(result.totalCost).toBe(8)
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.haltReason).toContain("budget ceiling exceeded")

    // evaluateSla correctly flags BOTH the cost overshoot and the status mismatch - it is not fooled
    // into thinking a halted-with-overshoot run is fine just because the halt itself was "expected"
    // runner behavior.
    expect(result.slaViolations.some((v) => v.toLowerCase().includes("cost"))).toBe(true)
    expect(result.slaViolations.some((v) => v.toLowerCase().includes("status"))).toBe(true)
  })

  test("a fully passing run reports zero SLA violations", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: LINEAR_ORG,
      idea: "all clear idea",
      costs: { evaluation: 1, planning: 1 },
      sla: { maxCost: 10, maxStages: 5, expectStatus: "completed", maxRetries: 2, deliverables: ["evaluation", "planning"] },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.slaViolations).toEqual([])
  })
})

describe("OrgBenchmark metric emit sink", () => {
  test("the injected sink captures the same BenchmarkResult that runBenchmark returns", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: LINEAR_ORG,
      idea: "emit sink idea",
      costs: { evaluation: 1, planning: 1 },
      sla: { maxCost: 10 },
    })
    const captured: OrgBenchmark.BenchmarkResult[] = []
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench, (r) => captured.push(r))

    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual(result)
  })

  test("runBenchmark works with no sink provided (default no-op)", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: LINEAR_ORG,
      idea: "no sink idea",
      costs: { evaluation: 1, planning: 1 },
      sla: {},
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)
    expect(result.status).toBe("completed")
  })

  test("a fake sink is not called before the run settles (only once, with the final result)", async () => {
    await using tmp = await tmpdir()
    const bench = OrgBenchmark.parse({
      org: GATED_ORG,
      idea: "single emit idea",
      costs: { evaluation: 1, planning: 1 },
      decisions: { evaluation: "revise" },
      sla: {},
    })
    let calls = 0
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench, () => {
      calls += 1
    })
    expect(calls).toBe(1)
    expect(result.status).toBe("completed")
  })
})
