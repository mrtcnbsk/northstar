// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgGraph } from "../../../src/kilocode/organization/graph"

const BASE = {
  ceo: "ceo",
  departments: {
    a: { chief: "a-chief", workers: ["a-worker"] },
    b: { chief: "b-chief", workers: ["b-worker"] },
    c: { chief: "c-chief", workers: ["c-worker"] },
  },
}

describe("OrgGraph.dependents", () => {
  test("linear pipeline A -> B -> C: dependents(X) = stages that DIRECTLY require X", () => {
    const org = OrgSchema.parse({
      ...BASE,
      pipeline: [{ stage: "a" }, { stage: "b" }, { stage: "c" }],
    })
    // resolveRequires is {a: [], b: [a], c: [b]}; dependents is its inverse.
    expect(OrgGraph.dependents(org)).toEqual({ a: ["b"], b: ["c"], c: [] })
  })

  test("diamond A -> {B, C} -> D: dependents(A) lists both direct consumers", () => {
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        a: { chief: "a-chief", workers: ["a-worker"] },
        b: { chief: "b-chief", workers: ["b-worker"] },
        c: { chief: "c-chief", workers: ["c-worker"] },
        d: { chief: "d-chief", workers: ["d-worker"] },
      },
      pipeline: [
        { stage: "a" },
        { stage: "b", requires: ["a"] },
        { stage: "c", requires: ["a"] },
        { stage: "d", requires: ["b", "c"] },
      ],
    })
    expect(OrgGraph.dependents(org)).toEqual({ a: ["b", "c"], b: ["d"], c: ["d"], d: [] })
  })

  test("every pipeline stage is present as a key, even with an empty array", () => {
    const org = OrgSchema.parse({
      ...BASE,
      pipeline: [{ stage: "a" }, { stage: "b" }, { stage: "c" }],
    })
    const result = OrgGraph.dependents(org)
    expect(Object.keys(result).sort()).toEqual(["a", "b", "c"])
    expect(result.c).toEqual([])
  })

  test("root stage with no dependents yields an empty array", () => {
    const org = OrgSchema.parse({
      ...BASE,
      pipeline: [{ stage: "a" }, { stage: "b", requires: [] }, { stage: "c", requires: [] }],
    })
    // b and c both explicitly declare no requires; nothing requires a either.
    expect(OrgGraph.dependents(org)).toEqual({ a: [], b: [], c: [] })
  })
})

describe("OrgGraph.impactRadius", () => {
  test("linear pipeline: impactRadius(a) is transitively [b, c], impactRadius(c) is []", () => {
    const org = OrgSchema.parse({
      ...BASE,
      pipeline: [{ stage: "a" }, { stage: "b" }, { stage: "c" }],
    })
    expect(OrgGraph.impactRadius(org, "a")).toEqual(["b", "c"])
    expect(OrgGraph.impactRadius(org, "b")).toEqual(["c"])
    expect(OrgGraph.impactRadius(org, "c")).toEqual([])
  })

  test("diamond: impactRadius(a) is [b, c, d] - deduped, in pipeline order", () => {
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        a: { chief: "a-chief", workers: ["a-worker"] },
        b: { chief: "b-chief", workers: ["b-worker"] },
        c: { chief: "c-chief", workers: ["c-worker"] },
        d: { chief: "d-chief", workers: ["d-worker"] },
      },
      pipeline: [
        { stage: "a" },
        { stage: "b", requires: ["a"] },
        { stage: "c", requires: ["a"] },
        { stage: "d", requires: ["b", "c"] },
      ],
    })
    // D is reachable via both B and C but must appear only once, in pipeline order.
    expect(OrgGraph.impactRadius(org, "a")).toEqual(["b", "c", "d"])
    expect(OrgGraph.impactRadius(org, "d")).toEqual([])
  })

  test("impactRadius never includes the stage itself", () => {
    const org = OrgSchema.parse({
      ...BASE,
      pipeline: [{ stage: "a" }, { stage: "b" }, { stage: "c" }],
    })
    expect(OrgGraph.impactRadius(org, "b")).not.toContain("b")
  })

  test("a stage with no downstream consumers has an empty impact radius", () => {
    const org = OrgSchema.parse({
      ...BASE,
      pipeline: [{ stage: "a" }, { stage: "b", requires: [] }, { stage: "c", requires: [] }],
    })
    expect(OrgGraph.impactRadius(org, "a")).toEqual([])
  })
})
