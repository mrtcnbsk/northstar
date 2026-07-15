import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgAudit } from "../../../src/kilocode/organization/audit"
import { OrgDriver } from "../../../src/kilocode/organization/driver"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["planner"] },
    build: { chief: "build-chief", workers: ["builder"] },
    delivery: { chief: "delivery-chief", workers: ["release-engineer"] },
    release: { chief: "delivery-chief", workers: ["release-engineer"] },
  },
  pipeline: [
    { stage: "plan", gate: "human" },
    { stage: "build" },
    { stage: "delivery", gate: "human" },
    { stage: "release" },
  ],
  loop: { maxIterations: 2, evaluatorModel: "haiku" },
})

const PLAN = ORG.pipeline.map(({ stage }) => ({
  stage,
  objective: `Complete ${stage}`,
  criteria: [`${stage} evidence is explicit`],
  agents: ORG.departments[stage].workers,
}))

async function approvePlan(dir: string) {
  const run = await OrgRunner.start(dir, ORG, "SP1 exit", undefined, "ses_owner")
  const deps = { costOf: async () => 0 }
  await OrgRunner.advance(deps, dir, ORG, run.runID, {})
  await Bun.write(OrgArtifacts.deliverablePath(dir, run.runID, "plan"), `plan ${"evidence ".repeat(20)}`)
  await OrgRunner.advance(deps, dir, ORG, run.runID, { taskID: "ses_plan" })
  await OrgRunner.commitPlan(dir, ORG, run.runID, PLAN)
  await OrgRunner.decide(dir, ORG, run.runID, "approve", undefined, "plan")
  return run.runID
}

describe("SP1 autonomous loop exit", () => {
  test("approved plan revises, passes, pauses at the delivery gate AND again at release's own irreversible-tool gate (Finding: per-stage irreversible approval)", async () => {
    await using tmp = await tmpdir()
    const runID = await approvePlan(tmp.path)
    const costs = new Map<string, number>()
    const stageCalls = new Map<string, number>()
    const evaluations = new Map<string, number>()
    const runtime: OrgDriver.Runtime = {
      costOf: async (taskID) => costs.get(taskID),
      spawnChief: async ({ runID, stage }) => {
        const call = (stageCalls.get(stage) ?? 0) + 1
        stageCalls.set(stage, call)
        const taskID = `ses_${stage}_${call}`
        costs.set(taskID, 1)
        await Bun.write(
          OrgArtifacts.deliverablePath(tmp.path, runID, stage),
          `${stage} v${call}: ${"positive evidence ".repeat(12)}`,
        )
        return { taskID, cost: 1, toolIDs: stage === "release" ? ["asc_submit"] : [] }
      },
      evaluate: async ({ stage }) => {
        const call = (evaluations.get(stage) ?? 0) + 1
        evaluations.set(stage, call)
        if (stage === "build" && call === 1) {
          return '{"pass":false,"reasons":["cite the focused test output"]}'
        }
        return '{"pass":true,"summary":"all criteria evidenced"}'
      },
    }

    const first = await OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID, runtime })
    expect(first).toEqual({
      type: "paused",
      kind: "final_gate",
      stage: "delivery",
      detail: "all criteria evidenced",
    })
    expect(stageCalls.get("build")).toBe(2)
    expect(stageCalls.get("release")).toBeUndefined()

    // Approving the delivery gate must NOT pre-authorize release's irreversible asc_submit. The
    // approval is minted for "delivery"; release touches a denylisted tool, so the driver stops at
    // release's OWN final gate instead of silently submitting on the strength of delivery's approval.
    await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "delivery")
    expect(await OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID, runtime })).toEqual({
      type: "paused",
      kind: "final_gate",
      stage: "release",
      detail: "all criteria evidenced",
    })
    expect(stageCalls.get("release")).toBe(1)

    // Now the human explicitly approves release's irreversible action; the run completes.
    await OrgRunner.decide(tmp.path, ORG, runID, "approve", undefined, "release")
    expect(await OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID, runtime })).toEqual({ type: "completed" })
    expect(stageCalls.get("release")).toBe(1)
    const audit = await OrgAudit.read(tmp.path, runID)
    // Two distinct human gates were reached: delivery, then release's own irreversible-tool gate.
    expect(audit.filter((entry) => entry.event === "final_gate")).toHaveLength(2)
    expect(audit.some((entry) => entry.stage === "release" && entry.decision === "evaluator-final_gate")).toBe(true)
    expect(audit.some((entry) => entry.stage === "release" && entry.decision === "approve")).toBe(true)
  })

  test("exhausted evaluator loop pauses with the latest actionable reason", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: { work: { chief: "work-chief", workers: ["worker"] } },
      pipeline: [{ stage: "work", criteria: ["proof exists"] }],
      loop: { maxIterations: 1 },
    })
    const run = await OrgRunner.start(tmp.path, org, "stuck exit")
    await OrgState.update(tmp.path, run.runID, (state) => {
      state.auto = true
      state.stages.work.objective = "Produce proof"
    })
    let call = 0
    const runtime: OrgDriver.Runtime = {
      costOf: async () => 0,
      spawnChief: async ({ runID, stage }) => {
        call += 1
        await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, stage), `attempt ${call} ${"content ".repeat(20)}`)
        return { taskID: `ses_work_${call}`, cost: 0, toolIDs: [] }
      },
      evaluate: async () => `{"pass":false,"reasons":["proof missing on attempt ${call}"]}`,
    }

    expect(await OrgDriver.attach({ projectDir: tmp.path, org, runID: run.runID, runtime })).toEqual({
      type: "paused",
      kind: "escalation",
      stage: "work",
      detail: "proof missing on attempt 2",
    })
  })
})
