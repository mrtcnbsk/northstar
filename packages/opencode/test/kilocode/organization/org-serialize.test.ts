// Task 6.3 (EPIC 6 TUI Builder) — organization.jsonc serializer + write/load round-trip +
// structural validation (cycle) + crossCheck (missing subordinate) coverage.
import { describe, test, expect } from "bun:test"
import { parse as parseJsonc } from "jsonc-parser"
import { tmpdir } from "../../fixture/fixture"
import { OrgSchema } from "../../../src/kilocode/organization/schema"

// A fully valid two-department org (build -> ship) exercising `gate`/`haltOn` on one stage and an
// explicit `requires` on the other. `ship` needed its OWN department entry (not in the Task 6.3
// brief's illustrative snippet) because OrgSchema.validate() requires every pipeline stage to have
// a matching department key — without it `loadOrganization` would reject the org and the
// write+load round-trip case ("resolves", "validate returns []") could never be satisfied.
function buildOrg(): OrgSchema.Organization {
  return {
    ceo: "ceo",
    departments: {
      build: { chief: "chief", workers: ["worker"] },
      ship: { chief: "ship-chief", workers: ["shipper"] },
    },
    shared: [],
    pipeline: [
      { stage: "build", gate: "human", haltOn: "no-go" },
      { stage: "ship", requires: ["build"] },
    ],
    toolpacks: [],
  }
}

describe("OrgSchema.serialize", () => {
  test("round-trips an in-memory Organization through serialize -> parseJsonc -> parse", () => {
    const org = buildOrg()
    const serialized = OrgSchema.serialize(org)
    const roundTripped = OrgSchema.parse(parseJsonc(serialized))
    expect(roundTripped).toEqual(org)
  })
})

describe("OrgSchema.writeOrganization", () => {
  test("writes organization.jsonc and loadOrganization reads it back valid", async () => {
    await using tmp = await tmpdir()
    const org = buildOrg()

    await OrgSchema.writeOrganization(tmp.path, org)

    const target = OrgSchema.organizationPath(tmp.path)
    expect(await Bun.file(target).exists()).toBe(true)

    const loaded = await OrgSchema.loadOrganization(tmp.path)
    expect(OrgSchema.validate(loaded)).toEqual([])
    expect(loaded).toEqual(org)
  })
})

describe("OrgSchema.validate — cycle detection", () => {
  test("rejects a pipeline dependency cycle (a requires b, b requires a)", () => {
    const cyclic = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        a: { chief: "a-chief", workers: ["a-worker"] },
        b: { chief: "b-chief", workers: ["b-worker"] },
      },
      shared: [],
      pipeline: [
        { stage: "a", requires: ["b"] },
        { stage: "b", requires: ["a"] },
      ],
      toolpacks: [],
    })

    const errors = OrgSchema.validate(cyclic)
    expect(errors.some((e) => e.includes("cycle"))).toBe(true)
  })
})

describe("OrgSchema.crossCheck — missing subordinate", () => {
  test("flags the ceo missing a chief as a declared subordinate", () => {
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        build: { chief: "chief", workers: ["worker"] },
      },
      shared: [],
      pipeline: [{ stage: "build" }],
      toolpacks: [],
    })

    const errors = OrgSchema.crossCheck(org, {
      ceo: { mode: "primary", subordinates: [] },
      chief: { mode: "subagent" },
      worker: { mode: "subagent" },
    })

    expect(errors.some((e) => e.includes("missing subordinate"))).toBe(true)
  })
})
