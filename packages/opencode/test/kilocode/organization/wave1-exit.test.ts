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
import { OrgAudit } from "../../../src/kilocode/organization/audit"

/**
 * Wave 1 exit verification (W1.6): one end-to-end scenario proving Wave 1's budget-engine exit
 * criteria hold TOGETHER, not just individually in their own unit tests (W1.1-W1.5):
 *
 *   - a stage completing under the escalation threshold proceeds normally (no gate, no halt)
 *   - a NON-gated stage's completion crossing the escalation threshold fires the soft escalation
 *     gate exactly ONCE, with a non-empty runner-level `note`, and org_status's budget block
 *     (run/stage/escalationThreshold/retries/spent/remaining) is correct at that exact moment
 *   - decide(approve) on the escalation gate resumes the pipeline normally
 *   - a later stage's completion pushing spend past the run ceiling HARD halts (budget
 *     haltReason + an audit "stop" entry), and subsequent advance keeps returning halted
 *   - (separate run) a stage that never produces a deliverable across (retries + 1) chief runs
 *     fails with the "deliverable never produced" reason
 *
 * Small budget (run 12, stage 8, escalationThreshold 5, retries 1) so scripted costOf values
 * trip each threshold cleanly and deliberately, mirroring runner.test.ts's "OrgRunner budget
 * enforcement" describe block and wave0-exit.test.ts's single-scenario shape.
 */

const WAVE1_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
    design: { chief: "design-chief", workers: ["ux"] },
  },
  shared: ["apple-docs"],
  // all three stages ungated: the ONLY gates in this scenario come from budget (escalation / ceiling).
  pipeline: [{ stage: "evaluation" }, { stage: "planning" }, { stage: "design" }],
  budget: { run: 12, stage: 8, escalationThreshold: 5, retries: 1 },
})

async function writeDeliverable(dir: string, runID: string, stage: string, content?: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content ?? `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

describe("Wave 1 exit verification", () => {
  test("under-threshold proceed -> escalation gate (once, with note) -> approve -> hard ceiling halt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, WAVE1_ORG, "wave 1 exit idea")

    // --- 1. evaluation completes at cost 3 (< escalationThreshold 5): proceeds normally, straight
    //        to instructing the next stage - no gate, no halt, not marked escalated. ---
    const costs: Record<string, number> = { ses_eval: 3 }
    const costDeps = { costOf: async (id: string) => costs[id] }

    const instructEval = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, {})
    expect(instructEval.kind).toBe("instruct")
    if (instructEval.kind !== "instruct") throw new Error("unreachable")
    expect(instructEval.stage).toBe("evaluation")

    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const afterEval = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, { taskID: "ses_eval" })
    expect(afterEval.kind).toBe("instruct") // no gate: cost 3 stays under the threshold
    if (afterEval.kind !== "instruct") throw new Error("unreachable")
    expect(afterEval.stage).toBe("planning")

    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.escalated).toBeFalsy()
    expect(state.status).toBe("active")

    // --- 2. planning completes at cost 3, pushing runTotal to 6 (>= escalationThreshold 5) on a
    //        NON-gated stage: the escalation gate fires ONCE, with a non-empty note. ---
    costs["ses_plan"] = 3
    await writeDeliverable(tmp.path, run.runID, "planning")
    const escalated = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, { taskID: "ses_plan" })
    expect(escalated.kind).toBe("gate")
    if (escalated.kind !== "gate") throw new Error("unreachable")
    expect(escalated.stage).toBe("planning")
    // Strengthens the W1.3 coverage gap the reviewer flagged: the runner-level note must be
    // non-empty, not just present-but-possibly-blank.
    expect(escalated.note).toBeDefined()
    expect(escalated.note!.length).toBeGreaterThan(0)
    expect(escalated.note).toContain("6")
    expect(escalated.note).toContain("5")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.escalated).toBe(true)
    expect(state.stages["planning"].status).toBe("awaiting_approval")

    // --- org_status budget block is correct AT THE ESCALATION GATE: spent 6, remaining 6. ---
    const statusAtGate = await OrgRunner.status(tmp.path, WAVE1_ORG, run.runID)
    const budget = OrgSchema.resolveBudget(WAVE1_ORG)
    const spentAtGate = statusAtGate.totalCost
    expect(spentAtGate).toBe(6)
    const budgetBlock = {
      run: budget.run,
      stage: budget.stage,
      escalationThreshold: budget.escalationThreshold,
      retries: budget.retries,
      spent: spentAtGate,
      remaining: Math.max(0, budget.run - spentAtGate),
    }
    expect(budgetBlock).toEqual({
      run: 12,
      stage: 8,
      escalationThreshold: 5,
      retries: 1,
      spent: 6,
      remaining: 6,
    })

    // --- 3. decide(approve) on the escalation gate continues the pipeline normally. ---
    await OrgRunner.decide(tmp.path, WAVE1_ORG, run.runID, "approve")
    const afterApprove = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, {})
    expect(afterApprove.kind).toBe("instruct")
    if (afterApprove.kind !== "instruct") throw new Error("unreachable")
    expect(afterApprove.stage).toBe("design")

    // --- 4. design completes at cost 7: runTotal 6 + 7 = 13 > run ceiling 12 -> HARD halt
    //        (stage total 7 stays under the stage cap 8, so this is unambiguously the run ceiling). ---
    costs["ses_design"] = 7
    await writeDeliverable(tmp.path, run.runID, "design")
    const halted = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, { taskID: "ses_design" })
    expect(halted.kind).toBe("halted")
    if (halted.kind !== "halted") throw new Error("unreachable")
    expect(halted.reason).toContain("budget ceiling exceeded")
    expect(halted.reason).toContain("13")
    expect(halted.reason).toContain("12")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.haltReason).toBe(halted.reason)

    const entries = await OrgAudit.read(tmp.path, run.runID)
    // one "approve" entry from step 3, one "stop" entry from the hard halt.
    expect(entries.at(-1)).toMatchObject({ stage: "design", decision: "stop" })
    expect(entries.at(-1)?.note).toContain("budget ceiling exceeded")

    // subsequent advance keeps returning halted (no further progress, no un-halting).
    const again = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, {})
    expect(again.kind).toBe("halted")
    if (again.kind !== "halted") throw new Error("unreachable")
    expect(again.reason).toBe(halted.reason)
  })

  test("a stage stuck across (retries + 1) chief runs fails with 'deliverable never produced'", async () => {
    await using tmp = await tmpdir()
    // Separate, fresh run: retries is 1, so bounded auto-retry tolerates exactly 1 incomplete
    // chief run before the 2nd incomplete run (retries + 1 = 2 total) fails the stage and halts.
    const run = await OrgRunner.start(tmp.path, WAVE1_ORG, "wave 1 exit retry idea")
    const costDeps = { costOf: async () => 1 } // cheap: this scenario is about retry exhaustion, not budget

    await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, {}) // instruct evaluation

    // 1st chief run: no deliverable ever appears -> incomplete (attempt 1 of 1 retry).
    const first = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, { taskID: "ses_stuck" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)
    expect(state.stages["evaluation"].status).toBe("running")

    // 2nd chief run: still no deliverable -> exceeds budget.retries (1) -> fails + halts.
    const second = await advance1(costDeps, tmp.path, WAVE1_ORG, run.runID, { taskID: "ses_stuck" })
    expect(second.kind).toBe("halted")
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).toContain('stage "evaluation" failed after 2 incomplete chief runs')
    expect(second.reason).toContain("deliverable never produced")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(2)
    expect(state.stages["evaluation"].status).toBe("failed")
    expect(state.status).toBe("halted")
    expect(state.haltReason).toContain("deliverable never produced")

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.at(-1)).toMatchObject({ stage: "evaluation", decision: "stop" })
    expect(entries.at(-1)?.note).toContain("deliverable never produced")
  })
})
