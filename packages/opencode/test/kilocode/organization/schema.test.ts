import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgSchema } from "../../../src/kilocode/organization/schema"

const VALID = {
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "evaluation", gate: "human", haltOn: "no-go" },
    { stage: "planning", gate: "human" },
  ],
}

describe("OrgSchema.parse + validate", () => {
  test("accepts a valid organization", () => {
    const org = OrgSchema.parse(VALID)
    expect(OrgSchema.validate(org)).toEqual([])
  })

  test("rejects pipeline stage without a department", () => {
    const org = OrgSchema.parse({ ...VALID, pipeline: [...VALID.pipeline, { stage: "ghost" }] })
    expect(OrgSchema.validate(org).some((e) => e.includes("ghost"))).toBe(true)
  })

  test("rejects duplicate pipeline stages", () => {
    const org = OrgSchema.parse({ ...VALID, pipeline: [VALID.pipeline[0], VALID.pipeline[0]] })
    expect(OrgSchema.validate(org).some((e) => e.includes("duplicate"))).toBe(true)
  })

  test("rejects a chief who is also a worker (cycle/role conflict)", () => {
    const org = OrgSchema.parse({
      ...VALID,
      departments: {
        ...VALID.departments,
        planning: { chief: "eval-chief", workers: ["market-research"] },
        broken: { chief: "x-chief", workers: ["eval-chief"] },
      },
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }, { stage: "broken" }],
    })
    expect(OrgSchema.validate(org).some((e) => e.includes("eval-chief"))).toBe(true)
  })

  test("rejects the ceo appearing as chief or worker", () => {
    const org = OrgSchema.parse({
      ...VALID,
      departments: { evaluation: { chief: "ceo", workers: ["market-research"] } },
      pipeline: [{ stage: "evaluation" }],
    })
    expect(OrgSchema.validate(org).some((e) => e.includes("ceo"))).toBe(true)
  })

  test("rejects wildcard and integer-like agent names", () => {
    const org = OrgSchema.parse({
      ...VALID,
      departments: {
        evaluation: { chief: "eval-chief", workers: ["*"] },
        planning: { chief: "42", workers: ["architect"] },
      },
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }],
    })
    const errors = OrgSchema.validate(org)
    expect(errors.some((e) => e.includes('"*"'))).toBe(true)
    expect(errors.some((e) => e.includes('"42"'))).toBe(true)
  })

  test("flags a pipeline stage named toString without a department (prototype safety)", () => {
    const org = OrgSchema.parse({ ...VALID, pipeline: [...VALID.pipeline, { stage: "toString" }] })
    expect(OrgSchema.validate(org).some((e) => e.includes("toString"))).toBe(true)
  })

  test("flags department keys that are not safe path segments", () => {
    const org = OrgSchema.parse({
      ...VALID,
      departments: { ...VALID.departments, "../x": { chief: "esc-chief", workers: ["esc-worker"] } },
      pipeline: [...VALID.pipeline, { stage: "../x" }],
    })
    expect(OrgSchema.validate(org).some((e) => e.includes("../x"))).toBe(true)
  })
})

describe("OrgSchema.loadOrganization", () => {
  test("loads .kilo/organization.jsonc with comments", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".kilo", "organization.jsonc"),
      `// org chart\n${JSON.stringify(VALID)}`,
    )
    const org = await OrgSchema.loadOrganization(tmp.path)
    expect(org.ceo).toBe("ceo")
    expect(org.pipeline.length).toBe(2)
  })

  test("throws a readable error when the file is missing", async () => {
    await using tmp = await tmpdir()
    await expect(OrgSchema.loadOrganization(tmp.path)).rejects.toThrow(/organization\.jsonc/)
  })

  test("wraps schema errors readably with the file path instead of raw zod JSON", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".kilo", "organization.jsonc"),
      `{"ceo":"ceo","departments":[],"pipeline":[]}`,
    )
    const err = await OrgSchema.loadOrganization(tmp.path).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toMatch(/Invalid organization\.jsonc at .*organization\.jsonc/)
    expect(err!.message).not.toContain('"code":"invalid_type"')
  })

  test("accepts trailing commas (JSONC convention)", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".kilo", "organization.jsonc"),
      [
        `{`,
        `  "ceo": "ceo",`,
        `  "departments": {`,
        `    "evaluation": { "chief": "eval-chief", "workers": ["market-research"] },`,
        `  },`,
        `  "shared": ["apple-docs"],`,
        `  "pipeline": [`,
        `    { "stage": "evaluation" },`,
        `  ],`,
        `}`,
      ].join("\n"),
    )
    const org = await OrgSchema.loadOrganization(tmp.path)
    expect(org.ceo).toBe("ceo")
    expect(org.pipeline.length).toBe(1)
  })

  test("reports JSONC syntax errors with the file path, not a misleading schema error", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(path.join(tmp.path, ".kilo", "organization.jsonc"), `{"ceo": "ceo", "departments": {`)
    const err = await OrgSchema.loadOrganization(tmp.path).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(err).toBeDefined()
    expect(err!.message).toContain("organization.jsonc")
    expect(err!.message).toMatch(/syntax error/i)
    expect(err!.message).not.toContain("expected array")
  })
})

describe("OrgSchema budget", () => {
  test("accepts an organization with a full budget block", () => {
    const org = OrgSchema.parse({
      ...VALID,
      budget: { run: 100, stage: 20, escalationThreshold: 15, retries: 3 },
    })
    expect(org.budget).toEqual({ run: 100, stage: 20, escalationThreshold: 15, retries: 3 })
    expect(OrgSchema.validate(org)).toEqual([])
  })

  test("omitted budget still parses (org.budget is undefined)", () => {
    const org = OrgSchema.parse(VALID)
    expect(org.budget).toBeUndefined()
    expect(OrgSchema.validate(org)).toEqual([])
  })

  test("rejects a negative budget value at parse time", () => {
    expect(() => OrgSchema.parse({ ...VALID, budget: { run: -1 } })).toThrow()
  })

  test("rejects a non-integer retries value at parse time", () => {
    expect(() => OrgSchema.parse({ ...VALID, budget: { retries: 1.5 } })).toThrow()
  })

  test("parses a per-stage budget override", () => {
    const org = OrgSchema.parse({
      ...VALID,
      pipeline: [{ ...VALID.pipeline[0], budget: 5 }, VALID.pipeline[1]],
    })
    expect(org.pipeline[0].budget).toBe(5)
  })

  test("rejects a negative per-stage budget override", () => {
    expect(() =>
      OrgSchema.parse({
        ...VALID,
        pipeline: [{ ...VALID.pipeline[0], budget: -5 }, VALID.pipeline[1]],
      }),
    ).toThrow()
  })
})

describe("OrgSchema.resolveBudget", () => {
  test("fills all four defaults when org.budget is absent", () => {
    const org = OrgSchema.parse(VALID)
    expect(OrgSchema.resolveBudget(org)).toEqual({ run: 50, stage: 15, escalationThreshold: 10, retries: 2 })
  })

  test("fills defaults for fields not provided while preserving provided values", () => {
    const org = OrgSchema.parse({ ...VALID, budget: { run: 200 } })
    expect(OrgSchema.resolveBudget(org)).toEqual({ run: 200, stage: 15, escalationThreshold: 10, retries: 2 })
  })

  test("preserves all provided values when the full block is given", () => {
    const org = OrgSchema.parse({
      ...VALID,
      budget: { run: 100, stage: 20, escalationThreshold: 15, retries: 3 },
    })
    expect(OrgSchema.resolveBudget(org)).toEqual({ run: 100, stage: 20, escalationThreshold: 15, retries: 3 })
  })
})

describe("OrgSchema.budgetWarnings", () => {
  test("returns [] for a sane budget (or no budget at all)", () => {
    const org = OrgSchema.parse(VALID)
    expect(OrgSchema.budgetWarnings(org)).toEqual([])
  })

  test("returns [] when stage and escalationThreshold are within run", () => {
    const org = OrgSchema.parse({ ...VALID, budget: { run: 50, stage: 15, escalationThreshold: 10 } })
    expect(OrgSchema.budgetWarnings(org)).toEqual([])
  })

  test("flags stage budget greater than run budget", () => {
    const org = OrgSchema.parse({ ...VALID, budget: { run: 10, stage: 15 } })
    const warnings = OrgSchema.budgetWarnings(org)
    expect(warnings.some((w) => w.includes("stage") && w.includes("run"))).toBe(true)
  })

  test("flags escalationThreshold greater than run budget", () => {
    const org = OrgSchema.parse({ ...VALID, budget: { run: 10, escalationThreshold: 20 } })
    const warnings = OrgSchema.budgetWarnings(org)
    expect(warnings.some((w) => w.includes("escalationThreshold") && w.includes("run"))).toBe(true)
  })

  test("does not throw / block loadOrganization-style validate when warnings are present", () => {
    const org = OrgSchema.parse({ ...VALID, budget: { run: 10, stage: 15, escalationThreshold: 20 } })
    // Hard validate() must stay green even though budgetWarnings would flag this org.
    expect(OrgSchema.validate(org)).toEqual([])
    expect(OrgSchema.budgetWarnings(org).length).toBe(2)
  })
})

describe("OrgSchema.crossCheck", () => {
  test("flags chiefs missing subordinates coverage and missing agents", () => {
    const org = OrgSchema.parse(VALID)
    const agents = {
      ceo: { mode: "primary", subordinates: ["eval-chief"] }, // missing planning-chief
      "eval-chief": { mode: "subagent", subordinates: ["market-research", "apple-docs"] },
      // planning-chief missing entirely; architect missing
      "market-research": { mode: "subagent" },
      "apple-docs": { mode: "subagent" },
    }
    const errors = OrgSchema.crossCheck(org, agents)
    expect(errors.some((e) => e.includes("planning-chief"))).toBe(true)
    expect(errors.some((e) => e.includes("architect"))).toBe(true)
    expect(errors.some((e) => e.includes("ceo") && e.includes("planning-chief"))).toBe(true)
  })

  test("passes a fully consistent org", () => {
    const org = OrgSchema.parse(VALID)
    const agents = {
      ceo: { mode: "primary", subordinates: ["eval-chief", "planning-chief"] },
      "eval-chief": { mode: "subagent", subordinates: ["market-research", "apple-docs"] },
      "planning-chief": { mode: "subagent", subordinates: ["architect", "apple-docs"] },
      "market-research": { mode: "subagent" },
      architect: { mode: "subagent" },
      "apple-docs": { mode: "subagent" },
    }
    expect(OrgSchema.crossCheck(org, agents)).toEqual([])
  })
})
