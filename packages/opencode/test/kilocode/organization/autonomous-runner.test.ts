import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["planner"] },
    build: { chief: "build-chief", workers: ["builder"] },
    ship: { chief: "ship-chief", workers: ["shipper"] },
  },
  pipeline: [
    { stage: "plan", gate: "human" },
    { stage: "build" },
    { stage: "ship", irreversible: true },
  ],
  loop: { maxIterations: 2, evaluatorModel: "haiku" },
})

const deps: OrgRunner.Deps = { costOf: async () => 1, now: () => 10_000 }
const content = (label: string) => `${label}: ${"evidence ".repeat(10)}`

async function reachPlanGate(projectDir: string, org = ORG, runnerDeps = deps) {
  const run = await OrgRunner.start(projectDir, org, "autonomous idea")
  await OrgRunner.advance(runnerDeps, projectDir, org, run.runID, {})
  await Bun.write(OrgArtifacts.deliverablePath(projectDir, run.runID, "plan"), content("approved plan"))
  await OrgRunner.advance(runnerDeps, projectDir, org, run.runID, { taskID: "ses_plan" })
  return run.runID
}

const approvedPlan = [
  { stage: "plan", objective: "Approve the execution contract", criteria: ["Every stage is measurable"] },
  { stage: "build", objective: "Build the feature", criteria: ["Focused tests pass"] },
  { stage: "ship", objective: "Publish safely", criteria: ["Release evidence is complete"] },
]

describe("OrgRunner autonomous transitions", () => {
  test("commits an exact approved-plan draft and enables auto only after the plan gate is approved", async () => {
    await using tmp = await tmpdir()
    const runID = await reachPlanGate(tmp.path)

    const drafted = await OrgRunner.commitPlan(tmp.path, ORG, runID, approvedPlan)
    expect(drafted.auto).toBe(false)
    expect(drafted.stages.build.objective).toBe("Build the feature")
    expect(drafted.stages.build.criteria).toEqual(["Focused tests pass"])

    const approved = await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "plan")
    expect(approved.auto).toBe(true)
    expect(approved.status).toBe("active")
  })

  test("rejects plans with missing, duplicate, unknown, or empty stage criteria", async () => {
    await using tmp = await tmpdir()
    const runID = await reachPlanGate(tmp.path)
    await expect(OrgRunner.commitPlan(tmp.path, ORG, runID, approvedPlan.slice(0, 2))).rejects.toThrow(/exactly/i)
    await expect(
      OrgRunner.commitPlan(tmp.path, ORG, runID, [...approvedPlan, approvedPlan[1]]),
    ).rejects.toThrow(/duplicate/i)
    await expect(
      OrgRunner.commitPlan(tmp.path, ORG, runID, [...approvedPlan.slice(0, 2), { ...approvedPlan[2], stage: "ghost" }]),
    ).rejects.toThrow(/unknown/i)
    await expect(
      OrgRunner.commitPlan(tmp.path, ORG, runID, [approvedPlan[0], { ...approvedPlan[1], criteria: [] }, approvedPlan[2]]),
    ).rejects.toThrow(/criteria/i)
  })

  test("holds an auto stage at an evaluator gate, then an evaluator pass completes it", async () => {
    await using tmp = await tmpdir()
    const runID = await reachPlanGate(tmp.path)
    await OrgRunner.commitPlan(tmp.path, ORG, runID, approvedPlan)
    await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "plan")

    const build = await OrgRunner.advance(deps, tmp.path, ORG, runID, {})
    expect(build.instruct.map((item) => item.stage)).toEqual(["build"])
    await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, "build"), content("build result"))
    const held = await OrgRunner.advance(deps, tmp.path, ORG, runID, { taskID: "ses_build" })
    expect(held.gate?.stage).toBe("build")
    expect((await OrgState.read(tmp.path, runID)).stages.ship.status).toBe("pending")

    const applied = await OrgRunner.applyVerdict(tmp.path, ORG, runID, "build", {
      pass: true,
      summary: "focused tests pass",
    }, 11_000)
    expect(applied.outcome).toBe("approved")
    expect(applied.run.stages.build.status).toBe("completed")
    expect(applied.run.stages.build.verdictHistory).toEqual([
      { pass: true, summary: "focused tests pass", ts: 11_000 },
    ])
  })

  test("revises within the loop cap and pauses with evaluator reasons after exhaustion", async () => {
    await using tmp = await tmpdir()
    const runID = await reachPlanGate(tmp.path)
    await OrgRunner.commitPlan(tmp.path, ORG, runID, approvedPlan)
    await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "plan")
    await OrgRunner.advance(deps, tmp.path, ORG, runID, {})
    await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, "build"), content("build v1"))
    await OrgRunner.advance(deps, tmp.path, ORG, runID, { taskID: "ses_build" })

    for (let iteration = 1; iteration <= 2; iteration++) {
      const revised = await OrgRunner.applyVerdict(
        tmp.path,
        ORG,
        runID,
        "build",
        { pass: false, reasons: [`missing evidence ${iteration}`] },
        11_000 + iteration,
      )
      expect(revised.outcome).toBe("revise")
      expect(revised.run.stages.build.iterations).toBe(iteration)
      await OrgRunner.advance(deps, tmp.path, ORG, runID, {})
      await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, "build"), content(`build v${iteration + 1}`))
      await OrgRunner.advance(deps, tmp.path, ORG, runID, { taskID: "ses_build" })
    }

    const exhausted = await OrgRunner.applyVerdict(
      tmp.path,
      ORG,
      runID,
      "build",
      { pass: false, reasons: ["still no proof"] },
      12_000,
    )
    expect(exhausted.outcome).toBe("escalated")
    expect(exhausted.run.status).toBe("paused")
    expect(exhausted.run.pausedReason).toEqual({
      kind: "escalation",
      stage: "build",
      detail: "still no proof",
    })
    expect(exhausted.run.stages.build.escalationNote).toBe("still no proof")
  })

  test("never auto-completes an irreversible stage even after an evaluator pass", async () => {
    await using tmp = await tmpdir()
    const runID = await reachPlanGate(tmp.path)
    await OrgRunner.commitPlan(tmp.path, ORG, runID, approvedPlan)
    await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "plan")
    await OrgState.update(tmp.path, runID, (run) => {
      run.stages.build.status = "completed"
      run.stages.ship.status = "awaiting_approval"
    })

    const result = await OrgRunner.applyVerdict(
      tmp.path,
      ORG,
      runID,
      "ship",
      { pass: true, summary: "release evidence complete" },
      13_000,
    )
    expect(result.outcome).toBe("final_gate")
    expect(result.run.status).toBe("paused")
    expect(result.run.stages.ship.status).toBe("awaiting_approval")

    const approved = await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "ship")
    expect(approved.status).toBe("active")
    expect(approved.pausedReason).toBeUndefined()
    expect(approved.stages.ship.status).toBe("completed")
  })

  test("resume turns an evaluator escalation into a steered revise, while advance short-circuits pauses", async () => {
    await using tmp = await tmpdir()
    const runID = await reachPlanGate(tmp.path)
    await OrgRunner.commitPlan(tmp.path, ORG, runID, approvedPlan)
    await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "plan")
    await OrgState.update(tmp.path, runID, (run) => {
      run.status = "paused"
      run.pausedReason = { kind: "escalation", stage: "build", detail: "tests missing" }
      run.stages.build.status = "awaiting_approval"
    })

    const held = await OrgRunner.advance(deps, tmp.path, ORG, runID, {})
    expect(held.paused?.kind).toBe("escalation")
    const resumed = await OrgRunner.resume(tmp.path, ORG, runID, "Run the focused suite and cite it")
    expect(resumed.status).toBe("active")
    expect(resumed.pausedReason).toBeUndefined()
    expect(resumed.stages.build.status).toBe("running")
    expect(resumed.stages.build.decision).toBe("revise")
  })

  test("existing budget hard stops still win before autonomous evaluation", async () => {
    await using tmp = await tmpdir()
    const budgetOrg = OrgSchema.parse({ ...ORG, budget: { run: 0.5, stage: 10, escalationThreshold: 10 } })
    const budgetDeps: OrgRunner.Deps = { costOf: async (taskID) => (taskID === "ses_plan" ? 0 : 1) }
    const runID = await reachPlanGate(tmp.path, budgetOrg, budgetDeps)
    await OrgRunner.commitPlan(tmp.path, budgetOrg, runID, approvedPlan)
    await OrgRunner.decide(tmp.path, budgetOrg, runID, "approve", undefined, "plan")
    await OrgRunner.advance(budgetDeps, tmp.path, budgetOrg, runID, {})
    await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, "build"), content("expensive build"))
    const result = await OrgRunner.advance(budgetDeps, tmp.path, budgetOrg, runID, { taskID: "ses_build" })
    expect(result.halted?.reason).toMatch(/budget ceiling exceeded/)
  })
})
