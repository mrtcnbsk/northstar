// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { buildAgentTree, budgetGauge } from "../../../src/kilocode/cockpit/cockpit-view"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research", "eval-worker-2"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

describe("buildAgentTree", () => {
  test("emits ceo + departments in pipeline order, chief liveness from the stage status, static worker roster", () => {
    const detail = {
      stages: [
        { stage: "evaluation", status: "running" },
        { stage: "planning", status: "pending" },
      ],
    }

    const tree = buildAgentTree(ORG, detail)

    expect(tree.ceo).toBe("ceo")
    expect(tree.departments).toHaveLength(2)
    expect(tree.departments.map((d) => d.stage)).toEqual(["evaluation", "planning"])

    const evaluation = tree.departments[0]
    expect(evaluation.chief).toBe("eval-chief")
    expect(evaluation.status).toBe("running")
    expect(evaluation.workers).toEqual(["market-research", "eval-worker-2"])

    const planning = tree.departments[1]
    expect(planning.chief).toBe("planning-chief")
    expect(planning.status).toBe("pending")
    expect(planning.workers).toEqual(["architect"])
  })

  // kilocode_change - wave-close review fix: a hand-edited .kilo/organization.jsonc can have a
  // pipeline stage with no matching `departments` entry (OrgSchema.parse is structural-only and
  // does not run the validate() cross-check that flags this). buildAgentTree must stay total
  // rather than dereferencing `dept.chief`/`dept.workers` on undefined.
  test("a pipeline stage with no matching departments entry does not throw -- emits a placeholder row", () => {
    const orgWithOrphanStage = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
      },
      pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
    })
    const detail = {
      stages: [
        { stage: "evaluation", status: "running" },
        { stage: "planning", status: "awaiting_approval" },
      ],
    }

    expect(() => buildAgentTree(orgWithOrphanStage, detail)).not.toThrow()

    const tree = buildAgentTree(orgWithOrphanStage, detail)
    expect(tree.departments).toHaveLength(2)
    const planning = tree.departments[1]
    expect(planning.stage).toBe("planning")
    expect(planning.chief).toBe("(no department)")
    expect(planning.workers).toEqual([])
    expect(planning.status).toBe("awaiting_approval")
  })
})

describe("budgetGauge", () => {
  test("spent=12, run=50, threshold=10 -> fractions + threshold crossed, ceiling not crossed", () => {
    const gauge = budgetGauge({ run: 50, escalationThreshold: 10, spent: 12 })
    expect(gauge.spentFraction).toBeCloseTo(0.24, 10)
    expect(gauge.thresholdFraction).toBeCloseTo(0.2, 10)
    expect(gauge.overThreshold).toBe(true)
    expect(gauge.overCeiling).toBe(false)
    expect(gauge.escalated).toBe(false)
  })

  test("run=0 -> every field zero/false, no NaN", () => {
    const gauge = budgetGauge({ run: 0, escalationThreshold: 0, spent: 0 })
    expect(gauge.spentFraction).toBe(0)
    expect(gauge.thresholdFraction).toBe(0)
    expect(gauge.overThreshold).toBe(false)
    expect(gauge.overCeiling).toBe(false)
    expect(gauge.escalated).toBe(false)
    expect(Number.isNaN(gauge.spentFraction)).toBe(false)
    expect(Number.isNaN(gauge.thresholdFraction)).toBe(false)
  })

  test("spent=60, run=50 -> spentFraction clamps to 1, ceiling crossed", () => {
    const gauge = budgetGauge({ run: 50, escalationThreshold: 10, spent: 60 })
    expect(gauge.spentFraction).toBe(1)
    expect(gauge.overCeiling).toBe(true)
  })

  test("escalated passes through as a boolean", () => {
    expect(budgetGauge({ run: 50, escalationThreshold: 10, spent: 5, escalated: true }).escalated).toBe(true)
    expect(budgetGauge({ run: 50, escalationThreshold: 10, spent: 5 }).escalated).toBe(false)
  })
})
