import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgAudit } from "../../../src/kilocode/organization/audit"
import { OrgConductor } from "../../../src/kilocode/organization/conductor"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"

function orgOf(
  stages: Array<{ stage: string; requires?: string[]; irreversible?: boolean }>,
  options: { maxIterations?: number; maxConcurrency?: number; runBudget?: number } = {},
) {
  return OrgSchema.parse({
    ceo: "ceo",
    departments: Object.fromEntries(
      stages.map(({ stage }) => [stage, { chief: `${stage}-chief`, workers: [`${stage}-worker`] }]),
    ),
    pipeline: stages,
    maxConcurrency: options.maxConcurrency,
    loop: { maxIterations: options.maxIterations ?? 2, evaluatorModel: "haiku" },
    budget: options.runBudget === undefined ? undefined : { run: options.runBudget, stage: 100, escalationThreshold: 100 },
  })
}

async function seedAuto(projectDir: string, org: OrgSchema.Organization) {
  const run = await OrgRunner.start(projectDir, org, "conductor fixture")
  return OrgState.update(projectDir, run.runID, (state) => {
    state.auto = true
    for (const entry of org.pipeline) {
      state.stages[entry.stage].objective = `Complete ${entry.stage}`
      state.stages[entry.stage].criteria = [`${entry.stage} evidence exists`]
    }
  })
}

function harness(input: {
  projectDir: string
  org: OrgSchema.Organization
  replies: string[]
  cost?: number
  tools?: (stage: string, call: number) => string[]
  settleDelay?: number
}) {
  const costs = new Map<string, number>()
  const calls = new Map<string, number>()
  const events: OrgConductor.Event[] = []
  let evaluatorCalls = 0
  let active = 0
  let peakActive = 0
  const deps: OrgConductor.Deps = {
    projectDir: input.projectDir,
    org: input.org,
    runnerDeps: { costOf: async (taskID) => costs.get(taskID), now: () => 50_000 },
    now: () => 50_000 + events.length,
    emit: (event) => events.push(event),
    spawnChief: async ({ runID, stage }) => {
      active += 1
      peakActive = Math.max(peakActive, active)
      const call = (calls.get(stage) ?? 0) + 1
      calls.set(stage, call)
      if (input.settleDelay) await new Promise((resolve) => setTimeout(resolve, input.settleDelay))
      await Bun.write(
        OrgArtifacts.deliverablePath(input.projectDir, runID, stage),
        `${stage} result ${call}: ${"positive evidence ".repeat(8)}`,
      )
      const taskID = `ses_${stage}_${call}`
      const cost = input.cost ?? 1
      costs.set(taskID, cost)
      active -= 1
      return { taskID, cost, toolIDs: input.tools?.(stage, call) ?? [] }
    },
    evaluate: async () => input.replies[evaluatorCalls++] ?? input.replies.at(-1) ?? '{"pass":true}',
  }
  return { deps, calls, events, evaluatorCalls: () => evaluatorCalls, peakActive: () => peakActive }
}

describe("OrgConductor.drive", () => {
  test("completes a stage that passes on the first evaluator attempt", async () => {
    await using tmp = await tmpdir()
    const org = orgOf([{ stage: "build" }])
    const run = await seedAuto(tmp.path, org)
    const h = harness({ projectDir: tmp.path, org, replies: ['{"pass":true,"summary":"evidenced"}'] })

    expect(await OrgConductor.drive(run.runID, h.deps)).toEqual({ type: "completed" })
    expect(h.calls.get("build")).toBe(1)
    expect(h.evaluatorCalls()).toBe(1)
    expect(h.events.map((event) => event.type)).toEqual([
      "stage_started",
      "deliverable_settled",
      "evaluator_verdict",
      "completed",
    ])
    expect((await OrgAudit.read(tmp.path, run.runID)).filter((entry) => entry.event).map((entry) => entry.event)).toEqual([
      "stage_started",
      "deliverable_settled",
      "evaluator_verdict",
      "completed",
    ])
  })

  test("re-instructs with evaluator reasons, then completes after a pass", async () => {
    await using tmp = await tmpdir()
    const org = orgOf([{ stage: "build" }])
    const run = await seedAuto(tmp.path, org)
    const h = harness({
      projectDir: tmp.path,
      org,
      replies: ['{"pass":false,"reasons":["cite the focused tests"]}', '{"pass":true}'],
    })

    expect(await OrgConductor.drive(run.runID, h.deps)).toEqual({ type: "completed" })
    expect(h.calls.get("build")).toBe(2)
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages.build.iterations).toBe(1)
    expect(state.stages.build.verdictHistory?.map((verdict) => verdict.pass)).toEqual([false, true])
    expect(h.events.some((event) => event.type === "revise_iteration" && event.detail === "cite the focused tests")).toBe(true)
  })

  test("pauses and escalates when revise verdicts exceed maxIterations, then resumes deterministically", async () => {
    await using tmp = await tmpdir()
    const org = orgOf([{ stage: "build" }], { maxIterations: 2 })
    const run = await seedAuto(tmp.path, org)
    const stuck = harness({
      projectDir: tmp.path,
      org,
      replies: ['{"pass":false,"reasons":["missing proof"]}'],
    })

    expect(await OrgConductor.drive(run.runID, stuck.deps)).toEqual({
      type: "paused",
      kind: "escalation",
      stage: "build",
      detail: "missing proof",
    })
    expect(stuck.calls.get("build")).toBe(3)
    await OrgRunner.resume(tmp.path, org, run.runID, "Include the exact command output")

    const resumed = harness({ projectDir: tmp.path, org, replies: ['{"pass":true}'] })
    expect(await OrgConductor.drive(run.runID, resumed.deps)).toEqual({ type: "completed" })
    expect(resumed.calls.get("build")).toBe(1)
  })

  test("pauses at a final gate for authored irreversible stages and denylisted tool use", async () => {
    for (const fixture of [
      { stage: { stage: "ship", irreversible: true }, tools: () => [] },
      { stage: { stage: "deploy" }, tools: () => ["asc_submit"] },
    ]) {
      await using tmp = await tmpdir()
      const org = orgOf([fixture.stage])
      const run = await seedAuto(tmp.path, org)
      const h = harness({ projectDir: tmp.path, org, replies: ['{"pass":true}'], tools: fixture.tools })

      const outcome = await OrgConductor.drive(run.runID, h.deps)
      expect(outcome.type).toBe("paused")
      if (outcome.type === "paused") expect(outcome.kind).toBe("final_gate")
      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages[fixture.stage.stage].status).toBe("awaiting_approval")
      expect(state.stages[fixture.stage.stage].toolsUsed).toEqual(fixture.tools())
    }
  })

  test("spawns a ready fan-out concurrently and evaluates each branch before completion", async () => {
    await using tmp = await tmpdir()
    const org = orgOf(
      [
        { stage: "frontend", requires: [] },
        { stage: "backend", requires: [] },
      ],
      { maxConcurrency: 2 },
    )
    const run = await seedAuto(tmp.path, org)
    const h = harness({ projectDir: tmp.path, org, replies: ['{"pass":true}'], settleDelay: 10 })

    expect(await OrgConductor.drive(run.runID, h.deps)).toEqual({ type: "completed" })
    expect(h.peakActive()).toBe(2)
    expect(h.evaluatorCalls()).toBe(2)
  })

  test("returns the runner budget halt before invoking the evaluator", async () => {
    await using tmp = await tmpdir()
    const org = orgOf([{ stage: "build" }], { runBudget: 1 })
    const run = await seedAuto(tmp.path, org)
    const h = harness({ projectDir: tmp.path, org, replies: ['{"pass":true}'], cost: 2 })

    const outcome = await OrgConductor.drive(run.runID, h.deps)
    expect(outcome.type).toBe("halted")
    if (outcome.type === "halted") expect(outcome.reason).toMatch(/budget ceiling exceeded/)
    expect(h.evaluatorCalls()).toBe(0)
  })

  test("turns a chief-session failure into a visible recoverable escalation", async () => {
    await using tmp = await tmpdir()
    const org = orgOf([{ stage: "build" }])
    const run = await seedAuto(tmp.path, org)
    const h = harness({ projectDir: tmp.path, org, replies: ['{"pass":true}'] })
    h.deps.spawnChief = async () => {
      throw new Error("provider unavailable")
    }

    expect(await OrgConductor.drive(run.runID, h.deps)).toEqual({
      type: "paused",
      kind: "escalation",
      stage: "build",
      detail: "chief session failed: provider unavailable",
    })
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("paused")
    expect(state.stages.build.status).toBe("awaiting_approval")
  })

  test("a budget-escalation gate pauses for a human in autonomous mode instead of being auto-approved by the evaluator", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: { build: { chief: "build-chief", workers: ["builder"] } },
      pipeline: [{ stage: "build" }],
      loop: { maxIterations: 2, evaluatorModel: "haiku" },
      // run cap high, but the escalation threshold (4) is crossed by the stage cost (5).
      budget: { run: 100, stage: 100, escalationThreshold: 4 },
    })
    const run = await seedAuto(tmp.path, org)
    const h = harness({ projectDir: tmp.path, org, replies: ['{"pass":true}'], cost: 5 })

    const outcome = await OrgConductor.drive(run.runID, h.deps)
    // The cost-escalation checkpoint must halt the autonomous loop for a human — NOT be silently
    // approved by the LLM evaluator (which would consume the once-per-run escalation flag).
    expect(outcome.type).toBe("paused")
    if (outcome.type !== "paused") throw new Error("unreachable")
    expect(outcome.kind).toBe("escalation")
    expect(outcome.stage).toBe("build")
    expect(outcome.detail).toContain("escalation threshold")
    expect(h.evaluatorCalls()).toBe(0)

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("paused")
    expect(state.escalated).toBe(true)
    expect(state.stages.build.status).toBe("awaiting_approval")
  })
})
