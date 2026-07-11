// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { advance1 } from "./batch-adapter"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"

/**
 * Wave 4 exit criteria made executable: DAG fan-out, conditional skip, timeout, and linear
 * back-compat.
 *
 * Wave 4 replaced the flat linear pipeline with a dependency DAG (W4.1-W4.7): independent stages
 * fan out concurrently, stages can be conditionally skipped, and per-stage timeouts bound
 * transient hangs. This file is the single end-to-end proof that all four headline capabilities
 * hold TOGETHER at the runner level (`OrgRunner.advance`/`decide`/`status`), driven with scripted
 * `costOf`+`now`, mirroring wave1-exit.test.ts's shape and reusing runner.test.ts's DIAMOND /
 * MODE_ORG / timeout fixtures and idioms verbatim rather than inventing a new harness.
 */

async function writeDeliverable(dir: string, runID: string, stage: string, content?: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content ?? `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

describe("Wave 4 exit verification", () => {
  // --- 1. Diamond fan-out (the headline): plan -> {frontend, backend} -> integrate, maxConcurrency:2. ---
  test("diamond fan-out: frontend+backend both instructed in ONE batch, integrate only after both settle", async () => {
    await using tmp = await tmpdir()
    const DIAMOND = OrgSchema.parse({
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

    // Distinct scripted costs per stage so totalCost at the end proves it's the sum of all four.
    // Kept well under the default escalationThreshold (10) and run ceiling (50) so this scenario
    // stays purely about the fan-out shape, not budget gating (that's covered elsewhere).
    const costs: Record<string, number> = { ses_plan: 0.5, ses_fe: 1, ses_be: 1.5, ses_int: 2 }
    const costDeps = { costOf: async (id: string) => costs[id] }

    const run = await OrgRunner.start(tmp.path, DIAMOND, "diamond exit idea")

    // advance -> instruct plan (its requires [] is immediately satisfiable; only 1 ready).
    const b1 = await OrgRunner.advance(costDeps, tmp.path, DIAMOND, run.runID, {})
    expect(b1.instruct.map((i) => i.stage)).toEqual(["plan"])

    // settle plan (pass its taskID) -> advance: BOTH frontend AND backend instructed in one batch.
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b2 = await OrgRunner.advance(costDeps, tmp.path, DIAMOND, run.runID, { taskID: "ses_plan" })
    expect(b2.instruct).toHaveLength(2)
    expect(b2.instruct.map((i) => i.stage).sort()).toEqual(["backend", "frontend"])
    expect(b2.instruct.map((i) => i.chief).sort()).toEqual(["be-chief", "fe-chief"]) // the two chiefs
    expect(b2.gate).toBeUndefined()
    expect(b2.incomplete).toBeUndefined()
    expect(b2.halted).toBeUndefined()

    // At the fan-out point, org_status-derived state shows BOTH running concurrently.
    let statusAtFanOut = await OrgRunner.status(tmp.path, DIAMOND, run.runID)
    expect(OrgState.runningStages(DIAMOND, statusAtFanOut.run).sort()).toEqual(["backend", "frontend"])
    expect(statusAtFanOut.run.stages["integrate"].status).toBe("pending")

    // settle both via taskResults: [{stage: frontend, taskID}, {stage: backend, taskID}].
    await writeDeliverable(tmp.path, run.runID, "frontend")
    await writeDeliverable(tmp.path, run.runID, "backend")
    const b3 = await OrgRunner.advance(costDeps, tmp.path, DIAMOND, run.runID, {
      taskResults: [
        { stage: "frontend", taskID: "ses_fe" },
        { stage: "backend", taskID: "ses_be" },
      ],
    })

    // integrate instructed only now, after BOTH branches settled.
    expect(b3.instruct.map((i) => i.stage)).toEqual(["integrate"])
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("completed")
    expect(state.stages["backend"].status).toBe("completed")
    expect(state.stages["integrate"].status).toBe("running")

    // settle integrate -> advance -> done.
    await writeDeliverable(tmp.path, run.runID, "integrate")
    const b4 = await OrgRunner.advance(costDeps, tmp.path, DIAMOND, run.runID, { taskID: "ses_int" })
    expect(b4.done).toBe(true)

    const finalStatus = await OrgRunner.status(tmp.path, DIAMOND, run.runID)
    expect(finalStatus.run.status).toBe("completed")
    // totalCost = sum of all four stages' scripted costs: 0.5 + 1 + 1.5 + 2 = 5.
    expect(finalStatus.totalCost).toBe(5)
  })

  // --- 2. Conditional skip: a terminal `marketing` stage gated on mode. ---
  test("conditional skip: mvp mode skips marketing (never instructed, 0 cost), full mode runs it", async () => {
    // plan -> marketing (requires plan, when:{mode:"full"}), terminal — nothing depends on it, so
    // the run's completion in mvp mode is a direct proof the skip doesn't strand the pipeline.
    const SKIP_ORG = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        plan: { chief: "plan-chief", workers: ["architect"] },
        marketing: { chief: "mkt-chief", workers: ["copywriter"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "plan" }, { stage: "marketing", requires: ["plan"], when: { mode: "full" } }],
    })
    const costDeps = { costOf: async () => 4 }

    // --- mvp run: marketing is skipped, run completes without ever instructing it. ---
    {
      await using tmp = await tmpdir()
      const run = await OrgRunner.start(tmp.path, SKIP_ORG, "skip idea mvp", "mvp")
      expect(run.mode).toBe("mvp")

      const b1 = await OrgRunner.advance(costDeps, tmp.path, SKIP_ORG, run.runID, {})
      expect(b1.instruct.map((i) => i.stage)).toEqual(["plan"])

      await writeDeliverable(tmp.path, run.runID, "plan")
      const b2 = await OrgRunner.advance(costDeps, tmp.path, SKIP_ORG, run.runID, { taskID: "ses_plan" })

      // marketing never instructed; the run completes immediately since marketing (skipped)
      // satisfies the pipeline and nothing depends on it.
      expect(b2.instruct.some((i) => i.stage === "marketing")).toBe(false)
      expect(b2.done).toBe(true)

      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["marketing"].status).toBe("skipped")
      expect(state.stages["marketing"].costs).toBeUndefined()
      expect(state.stages["marketing"].cost).toBeUndefined()
      expect(state.status).toBe("completed")

      const status = await OrgRunner.status(tmp.path, SKIP_ORG, run.runID)
      // plan (4) only; marketing (skipped) contributes 0.
      expect(status.totalCost).toBe(4)
      expect(status.pipeline.find((p) => p.stage === "marketing")!.status).toBe("skipped")
    }

    // --- Contrast: full mode instructs marketing normally. ---
    {
      await using tmp = await tmpdir()
      const run = await OrgRunner.start(tmp.path, SKIP_ORG, "skip idea full", "full")
      expect(run.mode).toBe("full")

      await OrgRunner.advance(costDeps, tmp.path, SKIP_ORG, run.runID, {})
      await writeDeliverable(tmp.path, run.runID, "plan")
      const b2 = await OrgRunner.advance(costDeps, tmp.path, SKIP_ORG, run.runID, { taskID: "ses_plan" })
      expect(b2.instruct.map((i) => i.stage)).toEqual(["marketing"])

      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["marketing"].status).toBe("running")

      await writeDeliverable(tmp.path, run.runID, "marketing")
      const b3 = await OrgRunner.advance(costDeps, tmp.path, SKIP_ORG, run.runID, { taskID: "ses_mkt" })
      expect(b3.done).toBe(true)
      const status = await OrgRunner.status(tmp.path, SKIP_ORG, run.runID)
      expect(status.totalCost).toBe(8) // plan (4) + marketing (4), both ran
    }
  })

  // --- 3. Timeout -> retry -> halt. ---
  test("timeout: a stage whose deliverable is never valid times out, retries once, then halts mentioning 'timeout'", async () => {
    await using tmp = await tmpdir()
    const TIMEOUT_ORG = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
      },
      shared: ["apple-docs"],
      // gate:human so a completed stage wouldn't silently auto-advance past what we assert (unused
      // here since the deliverable is never valid, but mirrors runner.test.ts's timeout fixture).
      pipeline: [{ stage: "evaluation", gate: "human", timeoutMs: 1000 }],
      budget: { retries: 1 },
    })
    const run = await OrgRunner.start(tmp.path, TIMEOUT_ORG, "timeout exit idea")

    // Drive the stage to running via a normal advance (no deliverable ever gets written for it).
    const b1 = await OrgRunner.advance({ costOf: async () => 0.1 }, tmp.path, TIMEOUT_ORG, run.runID, {})
    expect(b1.instruct.map((i) => i.stage)).toEqual(["evaluation"])
    const startedAtRaw = (await OrgState.read(tmp.path, run.runID)).stages["evaluation"].startedAt!
    const startedAt = Date.parse(startedAtRaw)

    // `now` scripted to jump well past startedAt + timeoutMs (1000ms).
    const clockDeps = { costOf: async () => 0.1, now: () => startedAt + 5000 }

    // 1st timing-out chief run: retry 1 of 1 -> incomplete (deliverable still missing).
    const first = await advance1(clockDeps, tmp.path, TIMEOUT_ORG, run.runID, { taskID: "ses_eval" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)
    expect(state.stages["evaluation"].status).toBe("running")

    // The stage never restarts on its own (still the same running attempt); startedAt is unchanged,
    // so the same scripted `now` still trips the timeout on the next chief run.
    // 2nd timing-out chief run: exceeds budget.retries (1) -> fails + halts, mentioning "timeout".
    const second = await advance1(clockDeps, tmp.path, TIMEOUT_ORG, run.runID, { taskID: "ses_eval" })
    expect(second.kind).toBe("halted")
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).toContain("timeout")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(2)
    expect(state.stages["evaluation"].status).toBe("failed")
    expect(state.status).toBe("halted")
    expect(state.haltReason).toContain("timeout")

    // org_status haltReason mentions the timeout.
    const status = await OrgRunner.status(tmp.path, TIMEOUT_ORG, run.runID)
    expect(status.run.haltReason).toContain("timeout")

    // Subsequent advance keeps returning halted.
    const again = await advance1(clockDeps, tmp.path, TIMEOUT_ORG, run.runID, {})
    expect(again.kind).toBe("halted")
  })

  // --- 4. Linear regression pin: NO DAG fields anywhere -> byte-identical pre-wave behavior. ---
  test("linear back-compat: an org with no DAG fields drives the exact pre-wave instruct sequence, one stage running at a time", async () => {
    await using tmp = await tmpdir()
    // No requires, no when, no timeoutMs, maxConcurrency unset (defaults to 1).
    const LINEAR = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
        design: { chief: "design-chief", workers: ["ux"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation", gate: "human" }, { stage: "planning" }, { stage: "design" }],
    })
    const deps = { costOf: async () => 1 }
    const run = await OrgRunner.start(tmp.path, LINEAR, "linear exit idea")

    const seq: string[] = []
    const runningCounts: number[] = []
    const step = async (input: { taskID?: string }) => {
      const a = await advance1(deps, tmp.path, LINEAR, run.runID, input)
      seq.push(a.kind === "instruct" || a.kind === "gate" ? `${a.kind}:${a.stage}` : a.kind)
      const state = await OrgState.read(tmp.path, run.runID)
      runningCounts.push(OrgState.runningStages(LINEAR, state).length)
      return a
    }

    await step({}) // instruct:evaluation
    let state = await OrgState.read(tmp.path, run.runID)
    expect(OrgState.runningStages(LINEAR, state)).toEqual(["evaluation"])

    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await step({ taskID: "ses_eval" }) // gate:evaluation (gate:human)
    await OrgRunner.decide(tmp.path, LINEAR, run.runID, "approve")

    await step({}) // instruct:planning
    state = await OrgState.read(tmp.path, run.runID)
    expect(OrgState.runningStages(LINEAR, state)).toEqual(["planning"])

    await writeDeliverable(tmp.path, run.runID, "planning")
    await step({ taskID: "ses_plan" }) // instruct:design (planning completes, design starts)
    state = await OrgState.read(tmp.path, run.runID)
    expect(OrgState.runningStages(LINEAR, state)).toEqual(["design"])

    await writeDeliverable(tmp.path, run.runID, "design")
    await step({ taskID: "ses_design" }) // done

    // Exact captured sequence, byte-identical to the pre-wave single-active-stage runner.
    expect(seq).toEqual(["instruct:evaluation", "gate:evaluation", "instruct:planning", "instruct:design", "done"])
    // One-running-stage-at-a-time invariant: at no point in the drive were 2+ stages running.
    expect(runningCounts.every((n) => n <= 1)).toBe(true)

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })
})
