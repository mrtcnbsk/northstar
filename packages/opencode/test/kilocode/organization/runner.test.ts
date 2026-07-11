// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgGraph } from "../../../src/kilocode/organization/graph"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgAudit } from "../../../src/kilocode/organization/audit"
import { advance1 } from "./batch-adapter"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

async function writeDeliverable(dir: string, runID: string, stage: string, content?: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content ?? `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

const deps = { costOf: async () => 0.42 }

describe("OrgRunner full flows", () => {
  test("no-go at gate 1 halts the run cleanly", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea one")

    // 1st advance: instructs the evaluation stage
    const first = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(first.kind).toBe("instruct")
    if (first.kind !== "instruct") throw new Error("unreachable")
    expect(first.stage).toBe("evaluation")
    expect(first.chief).toBe("eval-chief")
    expect(first.taskPrompt).toContain("evaluation")

    // chief "ran" and wrote the deliverable; CEO reports the task session id
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const second = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(second.kind).toBe("gate")
    if (second.kind !== "gate") throw new Error("unreachable")
    expect(second.stage).toBe("evaluation")

    // repeated advance while awaiting approval keeps returning the gate (idempotent)
    const again = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(again.kind).toBe("gate")

    const decided = await OrgRunner.decide(tmp.path, ORG, run.runID, "no-go", "market too small")
    expect(decided.status).toBe("halted")

    const after = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(after.kind).toBe("halted")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_eval: 0.42 })
    expect(state.stages["evaluation"].taskID).toBe("ses_eval")
    expect(state.stages["planning"].status).toBe("pending")
  })

  test("approve -> second stage -> done", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea two")

    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "approve")

    const third = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(third.kind).toBe("instruct")
    if (third.kind !== "instruct") throw new Error("unreachable")
    expect(third.stage).toBe("planning")
    // prior deliverable paths are threaded into the next stage prompt
    expect(third.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run.runID, "evaluation"))

    await writeDeliverable(tmp.path, run.runID, "planning")
    const done = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_plan" })
    expect(done.kind).toBe("done")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })

  test("incomplete deliverable returns incomplete with resume id", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea three")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    const result = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(result.kind).toBe("incomplete")
    if (result.kind !== "incomplete") throw new Error("unreachable")
    expect(result.resumeTaskID).toBe("ses_eval")
    expect(result.reason).toContain("deliverable")
  })

  test("incomplete carries the full stage prompt and chief for an unresumable fresh session", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea sixteen")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    const result = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(result.kind).toBe("incomplete")
    if (result.kind !== "incomplete") throw new Error("unreachable")
    expect(result.chief).toBe("eval-chief")
    expect(result.taskPrompt).toBeDefined()
    expect(result.taskPrompt).toContain("evaluation")
    expect(result.taskPrompt).toContain("idea sixteen")
    // no revise note: the stage is running for the first time, not being revised
    expect(result.taskPrompt).not.toContain("REVISION REQUESTED")
  })

  test("incomplete via unchanged-revise-baseline also carries chief and taskPrompt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea seventeen")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // re-instruct

    const stuck = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(stuck.kind).toBe("incomplete")
    if (stuck.kind !== "incomplete") throw new Error("unreachable")
    expect(stuck.chief).toBe("eval-chief")
    expect(stuck.taskPrompt).toBeDefined()
    expect(stuck.taskPrompt).toContain("evaluation")
  })

  test("incomplete after revise carries the revise note in the fresh-session prompt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea eighteen")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "add dark mode")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // re-instruct clears decision/decisionNote

    // the note must survive the re-instruct so an unresumable fresh session can still be briefed
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].reviseNote).toBe("add dark mode")

    // chief stalled: deliverable unchanged -> incomplete; the fresh-session prompt still carries the note
    const stuck = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(stuck.kind).toBe("incomplete")
    if (stuck.kind !== "incomplete") throw new Error("unreachable")
    expect(stuck.taskPrompt).toContain("REVISION REQUESTED")
    expect(stuck.taskPrompt).toContain("add dark mode")
  })

  test("revise sends the stage back to running with the note", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea four")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "check EU market too")

    const redo = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(redo.kind).toBe("instruct")
    if (redo.kind !== "instruct") throw new Error("unreachable")
    expect(redo.stage).toBe("evaluation")
    expect(redo.resumeTaskID).toBe("ses_eval")
    expect(redo.taskPrompt).toContain("check EU market too")
  })

  test("revise records the impact radius as invalidatedDownstream on the gated stage", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea impact radius")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "check EU market too")

    const state = await OrgState.read(tmp.path, run.runID)
    // planning requires evaluation (defaulted), so revising evaluation invalidates it downstream.
    expect(state.stages["evaluation"].invalidatedDownstream).toEqual(["planning"])
    expect(state.stages["evaluation"].invalidatedDownstream).toEqual(OrgGraph.impactRadius(ORG, "evaluation"))
    // planning's own status is untouched - invalidatedDownstream is pure metadata, not an auto-reopen.
    expect(state.stages["planning"].status).toBe("pending")
  })

  test("approve does not set invalidatedDownstream (only revise surfaces the impact radius)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea impact radius approve")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "approve")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].invalidatedDownstream).toBeUndefined()
  })

  test("decide outside a gate fails", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea five")
    await expect(OrgRunner.decide(tmp.path, ORG, run.runID, "approve")).rejects.toThrow(/no stage awaiting/i)
  })

  test("revise with unchanged deliverable cannot re-complete", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea six")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")

    // revise cleared the stale completion timestamp
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].completedAt).toBeUndefined()
    expect(state.stages["evaluation"].reviseBaseline).toBeDefined()

    const redo = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(redo.kind).toBe("instruct")

    // the chief did nothing; the pre-revise deliverable is still on disk and still "valid"
    const stuck = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(stuck.kind).toBe("incomplete")
    if (stuck.kind !== "incomplete") throw new Error("unreachable")
    expect(stuck.reason).toContain("unchanged")
    expect(stuck.resumeTaskID).toBe("ses_eval")
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].status).toBe("running")
  })

  test("revise with changed deliverable re-gates and clears the baseline", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea seven")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // re-instruct

    await writeDeliverable(tmp.path, run.runID, "evaluation", "# revised evaluation\n\n" + "new content ".repeat(20))
    const regate = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(regate.kind).toBe("gate")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].reviseBaseline).toBeUndefined()
    expect(state.stages["evaluation"].reviseNote).toBeUndefined() // lives and dies with the baseline
    expect(state.stages["evaluation"].completedAt).toBeDefined()
  })

  test("a failed stage halts advance without mutating run status", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea eight")
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "failed"
    })
    const result = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_failed" })
    expect(result.kind).toBe("halted")
    if (result.kind !== "halted") throw new Error("unreachable")
    expect(result.reason).toContain('stage "evaluation" failed')
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("active")
    expect(state.stages["evaluation"].taskID).toBe("ses_failed")
    expect(state.stages["planning"].status).toBe("pending")
  })

  test("stage retries up to budget.retries on repeated incomplete, then fails and halts", async () => {
    await using tmp = await tmpdir()
    // default budget.retries is 2: allows 2 retries (3 total chief runs) before giving up.
    const run = await OrgRunner.start(tmp.path, ORG, "idea retry one")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // instruct

    // 1st chief run: deliverable never appears -> incomplete (attempt 1, retry 1 of 2)
    const first = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)
    expect(state.stages["evaluation"].status).toBe("running")

    // 2nd chief run: still incomplete -> incomplete (attempt 2, retry 2 of 2)
    const second = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("incomplete")
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(2)
    expect(state.stages["evaluation"].status).toBe("running")

    // 3rd chief run: still incomplete -> exceeds budget.retries (2) -> fails + halts
    const third = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(third.kind).toBe("halted")
    if (third.kind !== "halted") throw new Error("unreachable")
    expect(third.reason).toContain('stage "evaluation" failed after 3 incomplete chief runs (deliverable never produced)')

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(3)
    expect(state.stages["evaluation"].status).toBe("failed")
    expect(state.status).toBe("halted")
    expect(state.haltReason).toContain('stage "evaluation" failed after 3 incomplete chief runs')

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.at(-1)).toMatchObject({ stage: "evaluation", decision: "stop" })
    expect(entries.at(-1)?.note).toContain('deliverable never produced')

    // the W0.4 failed-short-circuit defensively still catches it on the next advance
    const after = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(after.kind).toBe("halted")
    if (after.kind !== "halted") throw new Error("unreachable")
    expect(after.reason).toContain('stage "evaluation" failed')
  })

  test("budget.retries override of 1 fails the stage after a single retry", async () => {
    await using tmp = await tmpdir()
    const ORG_LOW_RETRIES = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
      budget: { retries: 1 },
    })
    const run = await OrgRunner.start(tmp.path, ORG_LOW_RETRIES, "idea retry two")
    await advance1(deps, tmp.path, ORG_LOW_RETRIES, run.runID, {})

    // 1st chief run: incomplete (attempt 1, retry 1 of 1)
    const first = await advance1(deps, tmp.path, ORG_LOW_RETRIES, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)

    // 2nd chief run: exceeds budget.retries (1) -> fails + halts
    const second = await advance1(deps, tmp.path, ORG_LOW_RETRIES, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("halted")
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).toContain('stage "evaluation" failed after 2 incomplete chief runs (deliverable never produced)')

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].status).toBe("failed")
  })

  test("a stage that completes on a retry proceeds normally with no failure", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea retry three")
    await advance1(deps, tmp.path, ORG, run.runID, {})

    // 1st chief run: incomplete (attempt 1, retry 1 of 2)
    const first = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)

    // 2nd chief run: deliverable now appears -> proceeds to gate; completion resets incompleteAttempts to 0
    // (so any later revise loop starts with a fresh retry budget, not the transient count).
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const second = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("gate")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(0)
    expect(state.stages["evaluation"].status).toBe("awaiting_approval")
  })

  test("a bare advance with no taskID (re-instruct only) does not burn a retry attempt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea retry four")
    const first = await advance1(deps, tmp.path, ORG, run.runID, {}) // instruct, no taskID
    expect(first.kind).toBe("instruct")
    // advancing again with no taskID re-returns instruct without recording any chief run
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts ?? 0).toBe(0)
  })

  test("cost accrued during a retry loop can trip the run budget ceiling before retries are exhausted", async () => {
    await using tmp = await tmpdir()
    const ORG_RETRY_BUDGET = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }],
      budget: { run: 10, stage: 100, escalationThreshold: 100, retries: 5 },
    })
    const run = await OrgRunner.start(tmp.path, ORG_RETRY_BUDGET, "idea retry five")
    await advance1(deps, tmp.path, ORG_RETRY_BUDGET, run.runID, {})

    // each incomplete retry accrues cost 6 for the SAME session id; run ceiling is 10.
    const costDeps = { costOf: async () => 6 }
    const first = await advance1(costDeps, tmp.path, ORG_RETRY_BUDGET, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_a: 6 })

    // 2nd incomplete: same session's cumulative cost grows to 11 -> overwrite -> runTotal 11 > cap 10 -> halted on BUDGET
    const costDeps2 = { costOf: async () => 11 }
    const second = await advance1(costDeps2, tmp.path, ORG_RETRY_BUDGET, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("halted")
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).toContain("budget ceiling exceeded")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    // retries were nowhere near exhausted (budget.retries: 5) - the budget ceiling caught it first
    expect(state.stages["evaluation"].incompleteAttempts).toBe(2)
    expect(state.stages["evaluation"].status).not.toBe("failed")
  })

  test("a revise loop that never changes the deliverable fails with a revise-specific reason", async () => {
    await using tmp = await tmpdir()
    // default budget.retries is 2: a revise iteration tolerates 2 unchanged re-runs before failing.
    const run = await OrgRunner.start(tmp.path, ORG, "idea revise fail")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" }) // -> gate
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // re-instruct

    // chief keeps re-emitting the SAME deliverable (unchanged since revise baseline)
    // 1st unchanged re-run -> incomplete (revise attempt 1 of 2)
    const first = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")
    if (first.kind !== "incomplete") throw new Error("unreachable")
    expect(first.reason).toContain("unchanged")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)

    // 2nd unchanged re-run -> incomplete (revise attempt 2 of 2)
    const second = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("incomplete")

    // 3rd unchanged re-run -> exceeds budget.retries (2) -> fails with the REVISE-specific reason
    const third = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(third.kind).toBe("halted")
    if (third.kind !== "halted") throw new Error("unreachable")
    expect(third.reason).toContain("unchanged revise")
    expect(third.reason).toContain("chief produced the same deliverable")
    expect(third.reason).not.toContain("never produced")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].status).toBe("failed")
    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.at(-1)?.note).toContain("unchanged revise")
  })

  test("a transient incomplete that then completes gives a later revise loop a FRESH retry budget", async () => {
    await using tmp = await tmpdir()
    // budget.retries is 2. A transient incomplete (attempts=1) then completes. The revise loop that
    // follows must tolerate the FULL retries+1 unchanged runs before failing - the reset means it is
    // NOT penalized by the earlier transient incomplete.
    const run = await OrgRunner.start(tmp.path, ORG, "idea revise reset")
    await advance1(deps, tmp.path, ORG, run.runID, {})

    // one transient incomplete: chief stalled once (incompleteAttempts -> 1)
    const stall = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(stall.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)

    // then the deliverable appears and the stage completes to its gate -> reset to 0
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const gate = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(gate.kind).toBe("gate")
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(0)

    // now revise; the chief keeps re-emitting the unchanged deliverable
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // re-instruct
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(0) // decide reset it too

    // it must take the FULL retries+1 (= 3) unchanged runs to fail, not fewer.
    const r1 = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(r1.kind).toBe("incomplete") // revise attempt 1 of 2
    const r2 = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(r2.kind).toBe("incomplete") // revise attempt 2 of 2 - would ALREADY be failed if the earlier transient counted
    const r3 = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_a" })
    expect(r3.kind).toBe("halted") // 3rd exceeds retries -> fails
    if (r3.kind !== "halted") throw new Error("unreachable")
    expect(r3.reason).toContain("unchanged revise")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(3)
    expect(state.stages["evaluation"].status).toBe("failed")
  })

  test("advance and decide with a mismatched pipeline throw", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea nine")
    const ORG3 = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        design: { chief: "design-chief", workers: ["ux"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      pipeline: [{ stage: "evaluation" }, { stage: "design" }, { stage: "planning" }],
    })
    await expect(OrgRunner.advance(deps, tmp.path, ORG3, run.runID, {})).rejects.toThrow(/different pipeline/)
    await expect(OrgRunner.decide(tmp.path, ORG3, run.runID, "approve")).rejects.toThrow(/different pipeline/)
  })

  test("advance and status throw when a run stage was removed from the pipeline", async () => {
    await using tmp = await tmpdir()
    const ORG_3STAGE = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        design: { chief: "design-chief", workers: ["ux"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      pipeline: [{ stage: "evaluation" }, { stage: "design" }, { stage: "planning" }],
    })
    const run = await OrgRunner.start(tmp.path, ORG_3STAGE, "idea fifteen")

    // organization.jsonc changed mid-run: "design" was removed from the pipeline
    const ORG_2STAGE = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }],
    })
    await expect(OrgRunner.advance(deps, tmp.path, ORG_2STAGE, run.runID, {})).rejects.toThrow(
      /stage "design" no longer in organization\.jsonc/,
    )
    await expect(OrgRunner.decide(tmp.path, ORG_2STAGE, run.runID, "approve")).rejects.toThrow(
      /stage "design" no longer in organization\.jsonc/,
    )
    await expect(OrgRunner.status(tmp.path, ORG_2STAGE, run.runID)).rejects.toThrow(
      /stage "design" no longer in organization\.jsonc/,
    )
  })

  test("taskID reported at a gate is persisted", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea ten")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // completes to gate without a taskID
    const again = await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_late" })
    expect(again.kind).toBe("gate")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].taskID).toBe("ses_late")
  })

  test("cost accumulates across sessions but not within a resumed session", async () => {
    await using tmp = await tmpdir()
    const costs: Record<string, number> = { ses_A: 5 }
    const costDeps = { costOf: async (id: string) => costs[id] }
    const run = await OrgRunner.start(tmp.path, ORG, "idea eleven")
    await advance1(costDeps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5 })
    let status = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(status.totalCost).toBe(5)

    // revise; the chief RESUMES ses_A whose cumulative cost grows to 7 -> overwrite, not 5 + 7
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "more depth")
    await advance1(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_A"] = 7
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take two\n\n" + "revised ".repeat(20))
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 7 })

    // revise again; a FRESH session ses_B costs 2 -> accumulate on top of prior spend
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "one more pass")
    await advance1(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_B"] = 2
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take three\n\n" + "fresh ".repeat(20))
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_B" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 7, ses_B: 2 })
    status = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(status.totalCost).toBe(9)
  })

  test("A-B-A session alternation does not double-count re-completed session cost", async () => {
    await using tmp = await tmpdir()
    const costs: Record<string, number> = { ses_A: 5 }
    const costDeps = { costOf: async (id: string) => costs[id] }
    const run = await OrgRunner.start(tmp.path, ORG, "idea twelve")

    // ses_A completes at cost 5
    await advance1(costDeps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5 })

    // revise; a DIFFERENT session ses_B completes at cost 2
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "try a different angle")
    await advance1(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_B"] = 2
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take two\n\n" + "session b ".repeat(20))
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_B" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5, ses_B: 2 })

    // revise again; back to ses_A, now with cumulative cost 8 (not a fresh 5+8)
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "back to the original take")
    await advance1(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_A"] = 8
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take three\n\n" + "session a again ".repeat(20))
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 8, ses_B: 2 })

    const status = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(status.totalCost).toBe(10) // NOT 15 (5 + 2 + 8)
  })

  test("legacy cost is seeded into the costs map when a new session completes post-upgrade", async () => {
    await using tmp = await tmpdir()
    const costs: Record<string, number> = { ses_new: 2 }
    const costDeps = { costOf: async (id: string) => costs[id] }
    const run = await OrgRunner.start(tmp.path, ORG, "idea fourteen")

    // simulate a pre-upgrade run: the stage is running with old-style single-slot cost tracking
    await advance1(costDeps, tmp.path, ORG, run.runID, {}) // start evaluation
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].cost = 5
      s.stages["evaluation"].costTaskID = "ses_old"
      // no `costs` map: written before per-session tracking existed
    })

    // post-upgrade, a FRESH session completes the stage at cost 2
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_new" })

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_old: 5, ses_new: 2 })
    // legacy fields are consumed by the migration; the persisted state.json is single-sourced now
    expect(state.stages["evaluation"].cost).toBeUndefined()
    expect(state.stages["evaluation"].costTaskID).toBeUndefined()

    const status = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(status.totalCost).toBe(7) // 5 (pre-upgrade spend) + 2, NOT 2
  })

  test("legacy state.json with old-style cost and no costs map is still summed in status", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea thirteen")
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "completed"
      s.stages["evaluation"].cost = 4.2
      // no `costs` map: simulates a state.json written before this change
    })
    const status = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(status.totalCost).toBe(4.2)
  })

  test("decide appends an audit entry with stage/decision/note/deliverableHash", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea audit one")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })

    const expectedHash = createHash("sha256")
      .update(await Bun.file(OrgArtifacts.deliverablePath(tmp.path, run.runID, "evaluation")).text())
      .digest("hex")

    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    const afterRevise = await OrgAudit.read(tmp.path, run.runID)
    expect(afterRevise.length).toBe(1)
    expect(afterRevise[0]).toMatchObject({
      stage: "evaluation",
      decision: "revise",
      note: "dig deeper",
      deliverableHash: expectedHash,
    })
    expect(typeof afterRevise[0].ts).toBe("string")
  })

  test("two decisions produce two audit entries in order", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea audit two")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })

    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await advance1(deps, tmp.path, ORG, run.runID, {}) // re-instruct
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# revised\n\n" + "more ".repeat(20))
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" }) // back to gate
    await OrgRunner.decide(tmp.path, ORG, run.runID, "approve")

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.length).toBe(2)
    expect(entries[0].decision).toBe("revise")
    expect(entries[1].decision).toBe("approve")
    expect(new Date(entries[0].ts).getTime()).toBeLessThanOrEqual(new Date(entries[1].ts).getTime())
  })

  test("org_status-level: approvals is [] when approvals.json is absent", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea audit three")
    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries).toEqual([])
  })

  test("corrupted approvals.json surfaces a readable error naming the file", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea audit four")
    const file = path.join(OrgState.runDir(tmp.path, run.runID), "approvals.json")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "not json")
    await expect(OrgAudit.read(tmp.path, run.runID)).rejects.toThrow(
      new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    )
  })

  test("stop halts an active run with a running stage, records reason and audit entry, and returns the taskID", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea stop one")
    await advance1(deps, tmp.path, ORG, run.runID, {})
    await advance1(deps, tmp.path, ORG, run.runID, { taskID: "ses_running" })

    const result = await OrgRunner.stop(tmp.path, ORG, run.runID, "user asked to abort")
    expect(result.run.status).toBe("halted")
    expect(result.run.haltReason).toBe("emergency stop: user asked to abort")
    expect(result.stage).toBe("evaluation")
    expect(result.taskID).toBe("ses_running")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.haltReason).toBe("emergency stop: user asked to abort")

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.length).toBe(1)
    expect(entries[0]).toMatchObject({ stage: "evaluation", decision: "stop", note: "user asked to abort" })

    // advance afterwards short-circuits on halted regardless of the running stage
    const after = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(after.kind).toBe("halted")
    if (after.kind !== "halted") throw new Error("unreachable")
    expect(after.reason).toBe("emergency stop: user asked to abort")
  })

  test("stop with no running stage records stage 'none' and still halts", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea stop two")

    const result = await OrgRunner.stop(tmp.path, ORG, run.runID, "changed my mind")
    expect(result.run.status).toBe("halted")
    expect(result.stage).toBeUndefined()
    expect(result.taskID).toBeUndefined()

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries[0]).toMatchObject({ stage: "none", decision: "stop", note: "changed my mind" })
  })
})

// A diamond org: plan -> {frontend, backend} -> integrate. frontend/backend both require plan;
// integrate requires both branches. Exercises the W4.3 fan-out batch runner.
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

describe("OrgRunner batch fan-out (W4.3)", () => {
  test("diamond with maxConcurrency:2 fans out frontend+backend in one batch, integrate after both", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, DIAMOND, "diamond idea")

    // 1st advance: instruct plan only (its requires [] is satisfiable; only 1 ready).
    const b1 = await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, {})
    expect(b1.instruct.map((i) => i.stage)).toEqual(["plan"])

    // plan completes -> both frontend and backend fan out in ONE batch (2 slots).
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b2 = await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_plan" })
    expect(b2.instruct.map((i) => i.stage).sort()).toEqual(["backend", "frontend"])
    expect(b2.gate).toBeUndefined()
    expect(b2.incomplete).toBeUndefined()
    expect(b2.halted).toBeUndefined()

    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("running")
    expect(state.stages["backend"].status).toBe("running")
    expect(state.stages["integrate"].status).toBe("pending")

    // settle frontend first (its taskID). backend still running -> integrate NOT ready yet.
    await writeDeliverable(tmp.path, run.runID, "frontend")
    const b3 = await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_fe" })
    expect(b3.instruct).toEqual([]) // integrate blocked on backend
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("completed")
    expect(state.stages["backend"].status).toBe("running")

    // settle backend -> now integrate fans out.
    await writeDeliverable(tmp.path, run.runID, "backend")
    const b4 = await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_be" })
    expect(b4.instruct.map((i) => i.stage)).toEqual(["integrate"])

    // integrate completes -> done.
    await writeDeliverable(tmp.path, run.runID, "integrate")
    const b5 = await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_int" })
    expect(b5.done).toBe(true)
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })

  test("maxConcurrency:1 on the same diamond stays sequential (one instruct at a time)", async () => {
    await using tmp = await tmpdir()
    const SEQ = OrgSchema.parse({ ...JSON.parse(JSON.stringify(DIAMOND)), maxConcurrency: 1 })
    const run = await OrgRunner.start(tmp.path, SEQ, "sequential diamond")

    // plan first.
    const b1 = await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, {})
    expect(b1.instruct.map((i) => i.stage)).toEqual(["plan"])

    // plan completes -> only ONE of frontend/backend starts (1 slot). Deterministic pipeline order: frontend.
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b2 = await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, { taskID: "ses_plan" })
    expect(b2.instruct.map((i) => i.stage)).toEqual(["frontend"])
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("running")
    expect(state.stages["backend"].status).toBe("pending") // NOT started: only 1 slot

    // frontend completes -> now backend starts (still 1 at a time).
    await writeDeliverable(tmp.path, run.runID, "frontend")
    const b3 = await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, { taskID: "ses_fe" })
    expect(b3.instruct.map((i) => i.stage)).toEqual(["backend"])

    // backend completes -> integrate.
    await writeDeliverable(tmp.path, run.runID, "backend")
    const b4 = await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, { taskID: "ses_be" })
    expect(b4.instruct.map((i) => i.stage)).toEqual(["integrate"])

    await writeDeliverable(tmp.path, run.runID, "integrate")
    const b5 = await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, { taskID: "ses_int" })
    expect(b5.done).toBe(true)
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })

  test("concurrent stages' summed cost trips the RUN ceiling and halts with the run reason", async () => {
    await using tmp = await tmpdir()
    // budget.run 10. frontend costs 6, backend costs 6 -> summed 12 > 10 once both settle.
    const BUDGET_DIAMOND = OrgSchema.parse({
      ...JSON.parse(JSON.stringify(DIAMOND)),
      budget: { run: 10, stage: 100, escalationThreshold: 100, retries: 2 },
    })
    const run = await OrgRunner.start(tmp.path, BUDGET_DIAMOND, "concurrent budget")
    const costOf = async (id: string) => (id === "ses_plan" ? 0 : 6) // plan free; each branch costs 6
    const costDeps = { costOf }

    await OrgRunner.advance(costDeps, tmp.path, BUDGET_DIAMOND, run.runID, {}) // plan
    await writeDeliverable(tmp.path, run.runID, "plan")
    await OrgRunner.advance(costDeps, tmp.path, BUDGET_DIAMOND, run.runID, { taskID: "ses_plan" }) // fan out fe+be

    // settle frontend (cost 6): runTotal 6, under ceiling.
    await writeDeliverable(tmp.path, run.runID, "frontend")
    const afterFe = await OrgRunner.advance(costDeps, tmp.path, BUDGET_DIAMOND, run.runID, { taskID: "ses_fe" })
    expect(afterFe.halted).toBeUndefined()

    // settle backend (cost 6): runTotal 12 > run cap 10 -> HALT on the run ceiling.
    await writeDeliverable(tmp.path, run.runID, "backend")
    const afterBe = await OrgRunner.advance(costDeps, tmp.path, BUDGET_DIAMOND, run.runID, { taskID: "ses_be" })
    expect(afterBe.halted).toBeDefined()
    expect(afterBe.halted!.reason).toContain("budget ceiling exceeded")
    expect(afterBe.halted!.reason).toContain("run")
    expect(afterBe.halted!.reason).toContain("12")
    expect(afterBe.halted!.reason).toContain("10")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.stages["integrate"].status).toBe("pending") // never fanned out
  })

  test("a gate on one branch surfaces as the single gate blocker while the other branch still fans out independently", async () => {
    await using tmp = await tmpdir()
    // A wider fan-out: plan -> {frontend(gate:human), backend, extra} all require plan.
    // maxConcurrency 3 so all three start; frontend gates, the others complete. On the settle call
    // the batch must carry frontend's gate AND still keep the run progressing.
    const GATED_DIAMOND = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        plan: { chief: "plan-chief", workers: ["architect"] },
        frontend: { chief: "fe-chief", workers: ["ui"] },
        backend: { chief: "be-chief", workers: ["api"] },
        extra: { chief: "ex-chief", workers: ["ops"] },
      },
      shared: ["apple-docs"],
      pipeline: [
        { stage: "plan" },
        { stage: "frontend", requires: ["plan"], gate: "human" },
        { stage: "backend", requires: ["plan"] },
        { stage: "extra", requires: ["plan"] },
      ],
      maxConcurrency: 3,
    })
    const run = await OrgRunner.start(tmp.path, GATED_DIAMOND, "gated diamond")

    await OrgRunner.advance(deps, tmp.path, GATED_DIAMOND, run.runID, {}) // plan
    await writeDeliverable(tmp.path, run.runID, "plan")
    const fan = await OrgRunner.advance(deps, tmp.path, GATED_DIAMOND, run.runID, { taskID: "ses_plan" })
    expect(fan.instruct.map((i) => i.stage).sort()).toEqual(["backend", "extra", "frontend"])

    // All three branches deliver. The CEO reports every finished task via task_results (the real
    // fan-out contract). On this one settle call the runner validates every REPORTED running stage
    // in pipeline order: frontend (gate:human) -> awaiting_approval, backend + extra -> completed.
    // The batch surfaces frontend's gate as the SINGLE serialized blocker (decision #6) while the two
    // independent branches transition to completed alongside it.
    await writeDeliverable(tmp.path, run.runID, "frontend")
    await writeDeliverable(tmp.path, run.runID, "backend")
    await writeDeliverable(tmp.path, run.runID, "extra")
    const b = await OrgRunner.advance(deps, tmp.path, GATED_DIAMOND, run.runID, {
      taskResults: [
        { stage: "frontend", taskID: "ses_fe" },
        { stage: "backend", taskID: "ses_be" },
        { stage: "extra", taskID: "ses_ex" },
      ],
    })

    // frontend awaiting approval -> the single gate blocker; the other two branches completed.
    expect(b.gate).toBeDefined()
    expect(b.gate!.stage).toBe("frontend")
    expect(b.gate!.note).toBeUndefined() // a plain human gate, not an escalation gate
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("awaiting_approval")
    expect(state.stages["backend"].status).toBe("completed")
    expect(state.stages["extra"].status).toBe("completed")
    // No further work fans out this call: nothing depends only on the completed branches; the run
    // stays active behind the frontend gate.
    expect(state.status).toBe("active")
    expect(b.instruct).toEqual([])
  })

  test("priorDeliverables is the transitive requires-closure, completed-only (not the pipeline prefix)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, DIAMOND, "closure idea")

    // Drive to integrate: plan -> {frontend, backend} -> integrate.
    await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "plan")
    await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_plan" })
    await writeDeliverable(tmp.path, run.runID, "frontend")
    await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_fe" })
    await writeDeliverable(tmp.path, run.runID, "backend")
    const b = await OrgRunner.advance(deps, tmp.path, DIAMOND, run.runID, { taskID: "ses_be" })

    // integrate's prompt threads its transitive-requires closure {plan, frontend, backend}, all completed.
    const integrate = b.instruct.find((i) => i.stage === "integrate")!
    expect(integrate).toBeDefined()
    expect(integrate.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run.runID, "plan"))
    expect(integrate.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run.runID, "frontend"))
    expect(integrate.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run.runID, "backend"))

    // And frontend's prompt (earlier, captured) includes ONLY plan — NOT backend, its diamond sibling
    // (backend is not in frontend's requires-closure, even though it precedes integrate in the array).
    const run2 = await OrgRunner.start(tmp.path, DIAMOND, "sibling exclusion")
    await OrgRunner.advance(deps, tmp.path, DIAMOND, run2.runID, {})
    await writeDeliverable(tmp.path, run2.runID, "plan")
    const fan = await OrgRunner.advance(deps, tmp.path, DIAMOND, run2.runID, { taskID: "ses_plan2" })
    const fe = fan.instruct.find((i) => i.stage === "frontend")!
    expect(fe.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run2.runID, "plan"))
    expect(fe.taskPrompt).not.toContain(OrgArtifacts.deliverablePath(tmp.path, run2.runID, "backend"))
  })

  test("linear regression pin: a 3-stage linear org (maxConcurrency unset -> 1) drives the exact pre-wave instruct sequence + gate", async () => {
    await using tmp = await tmpdir()
    // No DAG fields at all: requires defaults to [prevStage], maxConcurrency defaults to 1.
    // This must drive byte-identically to the pre-wave single-active-stage runner.
    const LINEAR3 = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
        design: { chief: "design-chief", workers: ["ux"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation", gate: "human" }, { stage: "planning" }, { stage: "design" }],
    })
    const run = await OrgRunner.start(tmp.path, LINEAR3, "linear pin idea")

    // Capture the whole action sequence and assert it matches the expected single-active-stage flow.
    const seq: string[] = []
    const step = async (input: { taskID?: string }) => {
      const a = await advance1(deps, tmp.path, LINEAR3, run.runID, input)
      seq.push(a.kind === "instruct" || a.kind === "gate" ? `${a.kind}:${a.stage}` : a.kind)
      return a
    }

    await step({}) // instruct:evaluation
    // Each stage: exactly ONE instruct, at most one running at a time.
    let state = await OrgState.read(tmp.path, run.runID)
    expect(OrgState.runningStages(LINEAR3, state)).toEqual(["evaluation"])

    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await step({ taskID: "ses_eval" }) // gate:evaluation (gate:human)
    await OrgRunner.decide(tmp.path, LINEAR3, run.runID, "approve")

    await step({}) // instruct:planning
    state = await OrgState.read(tmp.path, run.runID)
    expect(OrgState.runningStages(LINEAR3, state)).toEqual(["planning"]) // only one running

    await writeDeliverable(tmp.path, run.runID, "planning")
    await step({ taskID: "ses_plan" }) // instruct:design (planning completes, design starts)

    await writeDeliverable(tmp.path, run.runID, "design")
    await step({ taskID: "ses_design" }) // done

    expect(seq).toEqual([
      "instruct:evaluation",
      "gate:evaluation",
      "instruct:planning",
      "instruct:design",
      "done",
    ])
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })
})

describe("OrgRunner budget enforcement", () => {
  // Small explicit budgets so scripted costOf values trip them cleanly.
  const BUDGET_ORG = OrgSchema.parse({
    ceo: "ceo",
    departments: {
      evaluation: { chief: "eval-chief", workers: ["market-research"] },
      planning: { chief: "planning-chief", workers: ["architect"] },
      design: { chief: "design-chief", workers: ["ux"] },
    },
    shared: ["apple-docs"],
    pipeline: [{ stage: "evaluation" }, { stage: "planning" }, { stage: "design" }],
    budget: { run: 10, stage: 6, escalationThreshold: 4, retries: 2 },
  })

  const GATED_BUDGET_ORG = OrgSchema.parse({
    ceo: "ceo",
    departments: {
      evaluation: { chief: "eval-chief", workers: ["market-research"] },
      planning: { chief: "planning-chief", workers: ["architect"] },
    },
    shared: ["apple-docs"],
    pipeline: [{ stage: "evaluation", gate: "human" }, { stage: "planning" }],
    budget: { run: 10, stage: 6, escalationThreshold: 4, retries: 2 },
  })

  test("run halts at the RUN ceiling", async () => {
    await using tmp = await tmpdir()
    // escalation disabled (unreachable) so this test isolates the run-ceiling path only.
    const ORG_RUN_ONLY = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }],
      budget: { run: 10, stage: 6, escalationThreshold: 100, retries: 2 },
    })
    const run = await OrgRunner.start(tmp.path, ORG_RUN_ONLY, "idea budget one")

    // evaluation stage costs 5 (under stage cap 6, under run cap 10)
    const costDeps1 = { costOf: async () => 5 }
    await advance1(costDeps1, tmp.path, ORG_RUN_ONLY, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const afterEval = await advance1(costDeps1, tmp.path, ORG_RUN_ONLY, run.runID, { taskID: "ses_eval" })
    expect(afterEval.kind).toBe("instruct") // moved straight on to planning: no gate, no halt

    // planning stage costs 6 more: runTotal = 11 > run cap 10 -> halted (stageTotal 6 == cap 6, not tripped)
    const costDeps2 = { costOf: async () => 6 }
    await writeDeliverable(tmp.path, run.runID, "planning")
    const result = await advance1(costDeps2, tmp.path, ORG_RUN_ONLY, run.runID, { taskID: "ses_plan" })
    expect(result.kind).toBe("halted")
    if (result.kind !== "halted") throw new Error("unreachable")
    expect(result.reason).toContain("budget ceiling exceeded")
    expect(result.reason).toContain("run")
    expect(result.reason).toContain("11")
    expect(result.reason).toContain("10")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.haltReason).toBe(result.reason)

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.at(-1)).toMatchObject({ stage: "planning", decision: "stop" })
    expect(entries.at(-1)?.note).toContain("budget ceiling exceeded")

    // subsequent advance keeps returning halted
    const again = await advance1(costDeps2, tmp.path, ORG_RUN_ONLY, run.runID, {})
    expect(again.kind).toBe("halted")
  })

  test("run halts at a per-stage STAGE ceiling override lower than the global stage cap", async () => {
    await using tmp = await tmpdir()
    // per-stage override: evaluation capped at 3 (global stage cap is 6)
    const ORG_STAGE_OVERRIDE = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation", budget: 3 }, { stage: "planning" }],
      budget: { run: 10, stage: 6, escalationThreshold: 100, retries: 2 }, // escalation disabled (unreachable)
    })
    const run = await OrgRunner.start(tmp.path, ORG_STAGE_OVERRIDE, "idea budget two")

    const costDeps = { costOf: async () => 4 } // 4 > per-stage cap 3, but < global stage cap 6 and < run cap 10
    await advance1(costDeps, tmp.path, ORG_STAGE_OVERRIDE, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await advance1(costDeps, tmp.path, ORG_STAGE_OVERRIDE, run.runID, { taskID: "ses_eval" })

    expect(result.kind).toBe("halted")
    if (result.kind !== "halted") throw new Error("unreachable")
    expect(result.reason).toContain("budget ceiling exceeded")
    expect(result.reason).toContain("stage")
    expect(result.reason).toContain("evaluation")
    expect(result.reason).toContain("4")
    expect(result.reason).toContain("3")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.stages["planning"].status).toBe("pending") // never got a chance to start
  })

  test("escalation gate fires once per run: non-gated stage crossing threshold gates; decide(approve) proceeds; a later crossing does not re-gate", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, BUDGET_ORG, "idea budget three")

    // evaluation stage costs 5: crosses escalationThreshold (4), below stage cap (6) and run cap (10)
    const costDeps = { costOf: async () => 5 }
    await advance1(costDeps, tmp.path, BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await advance1(costDeps, tmp.path, BUDGET_ORG, run.runID, { taskID: "ses_eval" })

    expect(result.kind).toBe("gate")
    if (result.kind !== "gate") throw new Error("unreachable")
    expect(result.stage).toBe("evaluation")
    expect(result.note).toBeDefined()
    expect(result.note).toContain("5")
    expect(result.note).toContain("4")
    expect(result.note).toContain("escalation threshold")

    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.escalated).toBe(true)
    expect(state.stages["evaluation"].status).toBe("awaiting_approval")

    // decide(approve) on the escalation-gated stage completes it and proceeds, same as a normal gate
    await OrgRunner.decide(tmp.path, BUDGET_ORG, run.runID, "approve")
    const next = await advance1(costDeps, tmp.path, BUDGET_ORG, run.runID, {})
    expect(next.kind).toBe("instruct")
    if (next.kind !== "instruct") throw new Error("unreachable")
    expect(next.stage).toBe("planning")

    // planning stage also costs 5 -> runTotal would be 10, still >= threshold, but escalated
    // already true so it must NOT re-gate (only a hard ceiling could stop it now).
    await writeDeliverable(tmp.path, run.runID, "planning")
    const afterPlanning = await advance1(costDeps, tmp.path, BUDGET_ORG, run.runID, { taskID: "ses_plan" })
    expect(afterPlanning.kind).toBe("instruct") // proceeded straight to design, no re-gate
    if (afterPlanning.kind !== "instruct") throw new Error("unreachable")
    expect(afterPlanning.stage).toBe("design")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.escalated).toBe(true)
    expect(state.stages["planning"].status).toBe("completed")
  })

  test("escalation does not fire when the crossing stage already has gate:human (redundant), but still marks escalated", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, GATED_BUDGET_ORG, "idea budget four")

    // evaluation has gate:human already; cost 5 crosses escalationThreshold (4)
    const costDeps = { costOf: async () => 5 }
    await advance1(costDeps, tmp.path, GATED_BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await advance1(costDeps, tmp.path, GATED_BUDGET_ORG, run.runID, { taskID: "ses_eval" })

    expect(result.kind).toBe("gate")
    if (result.kind !== "gate") throw new Error("unreachable")
    expect(result.stage).toBe("evaluation")
    // redundant with the existing human gate: no escalation note attached
    expect(result.note).toBeUndefined()

    const state = await OrgState.read(tmp.path, run.runID)
    // still marked escalated so it never double-fires later in the run
    expect(state.escalated).toBe(true)
  })

  test("below-threshold run proceeds ungated and unhalted (regression)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, BUDGET_ORG, "idea budget five")

    // evaluation stage costs 2: below escalationThreshold (4), stage cap (6), run cap (10)
    const costDeps = { costOf: async () => 2 }
    await advance1(costDeps, tmp.path, BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await advance1(costDeps, tmp.path, BUDGET_ORG, run.runID, { taskID: "ses_eval" })

    expect(result.kind).toBe("instruct")
    if (result.kind !== "instruct") throw new Error("unreachable")
    expect(result.stage).toBe("planning")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.escalated).toBeFalsy()
    expect(state.status).toBe("active")
  })

  test("hard ceiling beats escalation: a stage completion crossing BOTH threshold and run ceiling halts, not gates", async () => {
    await using tmp = await tmpdir()
    // escalationThreshold lower than run cap so a single stage cost can cross both at once.
    const ORG_BOTH = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
        planning: { chief: "planning-chief", workers: ["architect"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }],
      budget: { run: 10, stage: 15, escalationThreshold: 4, retries: 2 },
    })
    const run = await OrgRunner.start(tmp.path, ORG_BOTH, "idea budget six")

    // evaluation costs 11: crosses escalationThreshold (4) AND run cap (10); stage cap (15) not tripped.
    const costDeps = { costOf: async () => 11 }
    await advance1(costDeps, tmp.path, ORG_BOTH, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await advance1(costDeps, tmp.path, ORG_BOTH, run.runID, { taskID: "ses_eval" })

    expect(result.kind).toBe("halted")
    if (result.kind !== "halted") throw new Error("unreachable")
    expect(result.reason).toContain("budget ceiling exceeded")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    // hard ceiling took precedence: escalation must not have been marked as a gate outcome
    expect(state.stages["evaluation"].status).not.toBe("awaiting_approval")
  })

  test("escalation note survives a concurrent EARLIER plain gate: B's note surfaces once A is resolved", async () => {
    await using tmp = await tmpdir()
    // maxConcurrency:2 fan-out: plan (root) -> A (gate:human, earlier in pipeline), B (no gate,
    // later in pipeline), both requiring plan. Threshold 5 so B's completion (cost 6) crosses it
    // while A settles to a PLAIN gate (no note) first in pipeline order. Reproduces the confirmed
    // finding: the blocker-selection keeps the earliest gate by pipeline index, so A's plain gate
    // (no note) would overwrite B's note-carrying escalation gate before the fix.
    const FANOUT_BUDGET_ORG = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        plan: { chief: "plan-chief", workers: ["architect"] },
        A: { chief: "a-chief", workers: ["reviewer"] },
        B: { chief: "b-chief", workers: ["builder"] },
      },
      shared: ["apple-docs"],
      pipeline: [
        { stage: "plan" },
        { stage: "A", requires: ["plan"], gate: "human" },
        { stage: "B", requires: ["plan"] },
      ],
      maxConcurrency: 2,
      budget: { run: 100, stage: 100, escalationThreshold: 5, retries: 2 },
    })
    const run = await OrgRunner.start(tmp.path, FANOUT_BUDGET_ORG, "idea fanout escalation")
    const costOf = async (id: string) => (id === "ses_plan" ? 0 : id === "ses_b" ? 6 : 0)
    const costDeps = { costOf }

    // plan runs and completes cheaply -> A and B fan out (2 slots).
    await OrgRunner.advance(costDeps, tmp.path, FANOUT_BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "plan")
    const fan = await OrgRunner.advance(costDeps, tmp.path, FANOUT_BUDGET_ORG, run.runID, { taskID: "ses_plan" })
    expect(fan.instruct.map((i) => i.stage).sort()).toEqual(["A", "B"])

    // settle A: its own gate:human fires, no escalation note (A's cost is 0, below threshold).
    await writeDeliverable(tmp.path, run.runID, "A")
    const afterA = await OrgRunner.advance(costDeps, tmp.path, FANOUT_BUDGET_ORG, run.runID, { taskID: "ses_a" })
    expect(afterA.gate).toBeDefined()
    expect(afterA.gate!.stage).toBe("A")
    expect(afterA.gate!.note).toBeUndefined()
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].status).toBe("awaiting_approval")
    expect(state.stages["B"].status).toBe("running")

    // settle B: crosses the escalation threshold (cost 6 >= 5) -> escalated=true, B -> awaiting_approval.
    // A is STILL awaiting (earlier in pipeline order) so A's plain gate is the batch's single blocker
    // this call -- B's escalation must not be lost even though it isn't surfaced THIS call.
    await writeDeliverable(tmp.path, run.runID, "B")
    const afterB = await OrgRunner.advance(costDeps, tmp.path, FANOUT_BUDGET_ORG, run.runID, { taskID: "ses_b" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.escalated).toBe(true)
    expect(state.stages["B"].status).toBe("awaiting_approval")
    expect(afterB.gate!.stage).toBe("A") // A still earliest in pipeline order

    // resolve A -> the next advance must surface B's gate WITH the escalation note.
    await OrgRunner.decide(tmp.path, FANOUT_BUDGET_ORG, run.runID, "approve")
    const afterResolveA = await OrgRunner.advance(costDeps, tmp.path, FANOUT_BUDGET_ORG, run.runID, {})
    expect(afterResolveA.gate).toBeDefined()
    expect(afterResolveA.gate!.stage).toBe("B")
    expect(afterResolveA.gate!.note).toBeDefined()
    expect(afterResolveA.gate!.note).toContain("escalation threshold")
    expect(afterResolveA.gate!.note).toContain("6")
    expect(afterResolveA.gate!.note).toContain("5")
  })
})

// W4.4: conditional `when` stage skipping + run-level `mode`.
// plan -> marketing (requires plan, when:{mode:"full"}) -> launch (requires marketing).
const MODE_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    marketing: { chief: "mkt-chief", workers: ["copywriter"] },
    launch: { chief: "launch-chief", workers: ["ops"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "plan" },
    { stage: "marketing", requires: ["plan"], when: { mode: "full" } },
    { stage: "launch", requires: ["marketing"] },
  ],
  maxConcurrency: 2,
})

// evaluation (gate:human) -> deep_build (requires evaluation, when:{stage:"evaluation",decision:"approve"}).
const DECISION_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    deep_build: { chief: "build-chief", workers: ["engineer"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "evaluation", gate: "human" },
    { stage: "deep_build", requires: ["evaluation"], when: { stage: "evaluation", decision: "approve" } },
  ],
})

describe("OrgRunner conditional `when` skipping (W4.4)", () => {
  test("mode mismatch skips the stage (no instruct, no cost) and its dependent still resolves", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, MODE_ORG, "idea mvp", "mvp")
    expect(run.mode).toBe("mvp")

    // plan runs first (marketing requires it).
    const b1 = await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, {})
    expect(b1.instruct.map((i) => i.stage)).toEqual(["plan"])

    // plan completes -> marketing becomes ready, but mode "mvp" !== when.mode "full" -> skipped.
    // launch depends only on marketing, so once marketing is satisfied (skipped counts), launch
    // becomes ready in the SAME advance call and fills the freed slot.
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b2 = await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, { taskID: "ses_plan" })
    expect(b2.instruct.map((i) => i.stage)).toEqual(["launch"])
    expect(b2.instruct.some((i) => i.stage === "marketing")).toBe(false)

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["marketing"].status).toBe("skipped")
    expect(state.stages["marketing"].startedAt).toBeUndefined()
    expect(state.stages["marketing"].attempts).toBe(0)
    expect(state.stages["marketing"].costs).toBeUndefined()
    expect(state.stages["marketing"].cost).toBeUndefined()
    expect(state.stages["launch"].status).toBe("running")

    // launch completes -> done. marketing never appears in any cost sum.
    await writeDeliverable(tmp.path, run.runID, "launch")
    const b3 = await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, { taskID: "ses_launch" })
    expect(b3.done).toBe(true)
    const status = await OrgRunner.status(tmp.path, MODE_ORG, run.runID)
    // plan (0.42) + launch (0.42) only; marketing (skipped) contributes nothing to the sum.
    expect(status.totalCost).toBe(0.84)
    expect(status.pipeline.find((p) => p.stage === "marketing")!.status).toBe("skipped")
    expect(status.pipeline.find((p) => p.stage === "marketing")!.costs).toBeUndefined()
  })

  test("mode match runs the stage normally (instruct emitted)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, MODE_ORG, "idea full", "full")
    expect(run.mode).toBe("full")

    await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b2 = await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, { taskID: "ses_plan" })
    expect(b2.instruct.map((i) => i.stage)).toEqual(["marketing"])
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["marketing"].status).toBe("running")
  })

  test("no mode set (undefined) does not satisfy a mode when-condition -> stage is skipped", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, MODE_ORG, "idea no mode")
    expect(run.mode).toBeUndefined()

    await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b2 = await OrgRunner.advance(deps, tmp.path, MODE_ORG, run.runID, { taskID: "ses_plan" })
    expect(b2.instruct.some((i) => i.stage === "marketing")).toBe(false)
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["marketing"].status).toBe("skipped")
  })

  test("when:{stage,decision} — deep_build runs when evaluation was approved", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, DECISION_ORG, "idea approve path")

    await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, DECISION_ORG, run.runID, "approve")

    const b = await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, {})
    expect(b.instruct.map((i) => i.stage)).toEqual(["deep_build"])
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["deep_build"].status).toBe("running")
  })

  test("when:{stage,decision} — deep_build is skipped when evaluation was revised (decision !== approve)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, DECISION_ORG, "idea revise path")

    await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, DECISION_ORG, run.runID, "revise", "dig deeper")
    // re-instruct clears decision back to undefined while revise is in flight
    await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# evaluation deliverable\n\nrevised content ".repeat(10))
    await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, { taskID: "ses_eval" })
    // evaluation has no gate:human on the revise re-completion path in this org config... but here
    // evaluation DOES have gate:human, so it re-gates; decide "no-go" this time.
    await OrgRunner.decide(tmp.path, DECISION_ORG, run.runID, "no-go", "not worth it")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].decision).toBe("no-go")
    expect(state.status).toBe("halted") // no-go halts the run before deep_build could ever be evaluated
  })

  test("when:{stage,decision} — deep_build is skipped on a fresh run where evaluation decision is stored directly as revise", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, DECISION_ORG, "idea decided revise")
    // Construct state directly: evaluation completed with a recorded "revise" decision (a decision
    // that was made and then the stage was independently marked completed, without an active
    // run halt) — exercises whenSatisfied's false branch for a decision that isn't "approve".
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "completed"
      s.stages["evaluation"].decision = "revise"
    })

    const b = await OrgRunner.advance(deps, tmp.path, DECISION_ORG, run.runID, {})
    expect(b.instruct.some((i) => i.stage === "deep_build")).toBe(false)
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["deep_build"].status).toBe("skipped")
  })

  test("no `when` present -> stage always runs (today's behavior, unaffected)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea unconditional")
    const b = await advance1(deps, tmp.path, ORG, run.runID, {})
    expect(b.kind).toBe("instruct")
    if (b.kind !== "instruct") throw new Error("unreachable")
    expect(b.stage).toBe("evaluation")
  })

  test("a skipped-only ready set produces a batch with no instruct for it and status skipped", async () => {
    await using tmp = await tmpdir()
    // Single-stage-ready scenario: only marketing is ready (mode mismatch) with launch still
    // blocked (requires marketing, satisfied only once marketing settles to skipped/completed) —
    // asserted separately above via readiness re-derivation. Here we isolate: maxConcurrency:1,
    // only marketing ready this call (launch not yet, since it requires marketing to settle first
    // within the SAME loop iteration; re-derivation still applies with 1 slot).
    const SEQ = OrgSchema.parse({ ...JSON.parse(JSON.stringify(MODE_ORG)), maxConcurrency: 1 })
    const run = await OrgRunner.start(tmp.path, SEQ, "idea skip only", "mvp")
    await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b = await OrgRunner.advance(deps, tmp.path, SEQ, run.runID, { taskID: "ses_plan" })
    // marketing skipped, launch fans out into the single freed slot; marketing itself never instructed.
    expect(b.instruct.find((i) => i.stage === "marketing")).toBeUndefined()
    expect(b.instruct.map((i) => i.stage)).toEqual(["launch"])
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["marketing"].status).toBe("skipped")
  })

  test("a skip-eligible stage and an independently-ready normal stage in the SAME initial ready set both resolve in one advance call (skip doesn't consume a slot)", async () => {
    await using tmp = await tmpdir()
    // plan -> {marketing (when:{mode:"full"}), other} both require only plan; maxConcurrency:2 so
    // both are in the initial ready set together. marketing is skip-eligible (mode "mvp" != "full");
    // "other" has no `when` and must still be instructed in the SAME batch, proving the skip does
    // not eat into the concurrency slots meant for real work.
    const WIDE = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        plan: { chief: "plan-chief", workers: ["architect"] },
        marketing: { chief: "mkt-chief", workers: ["copywriter"] },
        other: { chief: "other-chief", workers: ["ops"] },
      },
      shared: ["apple-docs"],
      pipeline: [
        { stage: "plan" },
        { stage: "marketing", requires: ["plan"], when: { mode: "full" } },
        { stage: "other", requires: ["plan"] },
      ],
      maxConcurrency: 2,
    })
    const run = await OrgRunner.start(tmp.path, WIDE, "idea wide", "mvp")
    await OrgRunner.advance(deps, tmp.path, WIDE, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "plan")
    const b = await OrgRunner.advance(deps, tmp.path, WIDE, run.runID, { taskID: "ses_plan" })

    expect(b.instruct.map((i) => i.stage)).toEqual(["other"])
    expect(b.instruct.find((i) => i.stage === "marketing")).toBeUndefined()
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["marketing"].status).toBe("skipped")
    expect(state.stages["other"].status).toBe("running")
  })
})

describe("OrgRunner per-stage timeoutMs (W4.5)", () => {
  // Single-stage org (gate: "human" so a completed stage doesn't auto-advance past what we assert)
  // with a configurable timeoutMs on the "evaluation" stage; each test overrides budget as needed.
  function orgWithTimeout(timeoutMs: number | undefined, retries?: number) {
    return OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["market-research"] },
      },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation", gate: "human", timeoutMs }],
      budget: retries !== undefined ? { retries } : undefined,
    })
  }

  test("timeout fires: invalid deliverable past timeoutMs routes to the timeout retry path and halts mentioning 'timeout'", async () => {
    await using tmp = await tmpdir()
    const org = orgWithTimeout(1000, 1) // budget.retries: 1 -> fails on the 2nd timing-out chief run
    const run = await OrgRunner.start(tmp.path, org, "idea timeout one")

    const started = "2026-01-01T00:00:00.000Z"
    const T = Date.parse(started)
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].startedAt = started
      s.stages["evaluation"].attempts = 1
    })

    // now is 5000ms after startedAt: exceeds the 1000ms timeout.
    const clockDeps = { costOf: async () => 0.1, now: () => T + 5000 }

    // 1st timing-out chief run: retry 1 of 1 -> incomplete
    const first = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)
    expect(state.stages["evaluation"].status).toBe("running")

    // Reset startedAt for the retried run (the stage doesn't restart automatically here since we
    // manipulated state directly instead of going through advance's toRun loop; keep the same
    // started/now so the timeout still applies on the 2nd chief run).
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].startedAt = started
    })

    // 2nd timing-out chief run: exceeds budget.retries (1) -> fails + halts, mentioning "timeout"
    const second = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("halted")
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).toContain("timeout")
    expect(second.reason).toContain('stage "evaluation" failed after 2 attempts')
    expect(second.reason).toContain("1000ms timeout")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(2)
    expect(state.stages["evaluation"].status).toBe("failed")
    expect(state.status).toBe("halted")
    expect(state.haltReason).toContain("timeout")

    const entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.at(-1)).toMatchObject({ stage: "evaluation", decision: "stop" })
    expect(entries.at(-1)?.note).toContain("timeout")
  })

  test("completes before timeout: a VALID deliverable completes normally even with timeoutMs set", async () => {
    await using tmp = await tmpdir()
    const org = orgWithTimeout(100000)
    const run = await OrgRunner.start(tmp.path, org, "idea timeout two")

    const started = "2026-01-01T00:00:00.000Z"
    const T = Date.parse(started)
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].startedAt = started
      s.stages["evaluation"].attempts = 1
    })
    await writeDeliverable(tmp.path, run.runID, "evaluation")

    // now is only 1000ms after startedAt: well under the 100000ms timeout.
    const clockDeps = { costOf: async () => 0.1, now: () => T + 1000 }
    const result = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(result.kind).toBe("gate") // valid deliverable -> gates normally, never touches the timeout path
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].status).toBe("awaiting_approval")
  })

  test("no timeoutMs: invalid deliverable follows today's never-produced path, message unchanged, never a timeout", async () => {
    await using tmp = await tmpdir()
    const org = orgWithTimeout(undefined, 1)
    const run = await OrgRunner.start(tmp.path, org, "idea timeout three")

    const started = "2026-01-01T00:00:00.000Z"
    const T = Date.parse(started)
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].startedAt = started
      s.stages["evaluation"].attempts = 1
    })

    // "now" is far past any reasonable timeout, but timeoutMs is absent so it must never apply.
    const clockDeps = { costOf: async () => 0.1, now: () => T + 999999999 }

    const first = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete")

    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].startedAt = started
    })
    const second = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("halted")
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).not.toContain("timeout")
    expect(second.reason).toContain('stage "evaluation" failed after 2 incomplete chief runs (deliverable never produced)')

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.haltReason).not.toContain("timeout")
    expect(state.haltReason).toContain("deliverable never produced")
  })

  test("timeout uses the retry budget: with budget.retries 1, a timing-out stage retries once then halts (attempts accounting matches never-produced)", async () => {
    await using tmp = await tmpdir()
    const org = orgWithTimeout(500, 1)
    const run = await OrgRunner.start(tmp.path, org, "idea timeout four")

    const started = "2026-01-01T00:00:00.000Z"
    const T = Date.parse(started)
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].startedAt = started
      s.stages["evaluation"].attempts = 1
    })
    const clockDeps = { costOf: async () => 0.1, now: () => T + 10000 }

    const first = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(first.kind).toBe("incomplete") // attempt 1 of 1 retry: same accounting shape as never-produced
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(1)
    expect(state.stages["evaluation"].status).toBe("running")

    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].startedAt = started
    })
    const second = await advance1(clockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(second.kind).toBe("halted") // exceeds budget.retries (1) -> fails + halts, same shape as never-produced exhaustion
    if (second.kind !== "halted") throw new Error("unreachable")
    expect(second.reason).toContain("timeout")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].incompleteAttempts).toBe(2)
    expect(state.stages["evaluation"].status).toBe("failed")
  })

  test("no injected now: deps.now defaults to Date.now, timeoutMs check still works with a real (very past) startedAt", async () => {
    await using tmp = await tmpdir()
    const org = orgWithTimeout(1, 1) // 1ms timeout: any real elapsed time trips it
    const run = await OrgRunner.start(tmp.path, org, "idea timeout five")

    // startedAt far in the past: with no injected `now`, Date.now() - Date.parse(started) is huge.
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].startedAt = "2020-01-01T00:00:00.000Z"
      s.stages["evaluation"].attempts = 1
    })

    const noClockDeps = { costOf: async () => 0.1 } // no `now` -> defaults to Date.now
    const result = await advance1(noClockDeps, tmp.path, org, run.runID, { taskID: "ses_a" })
    expect(result.kind).toBe("incomplete")
    if (result.kind !== "incomplete") throw new Error("unreachable")
    expect(result.reason).toBeDefined()
  })
})

// Finding #1 (CRITICAL): passive re-settle must NOT burn a stalled branch's retry budget.
// Wave-4 adversarial-review repro. A diamond A∥B, both requires:[], maxConcurrency:2, retries:2,
// with a B tail b2 -> b3. A stalls (deliverable never valid) and keeps its taskID; sibling-driven
// advances (settling b2, then b3) must NOT re-run retryOrFail on the untouched A branch.
describe("OrgRunner passive re-settle (Finding #1)", () => {
  const AB_TAIL = OrgSchema.parse({
    ceo: "ceo",
    departments: {
      A: { chief: "a-chief", workers: ["wa"] },
      B: { chief: "b-chief", workers: ["wb"] },
      b2: { chief: "b2-chief", workers: ["wb2"] },
      b3: { chief: "b3-chief", workers: ["wb3"] },
    },
    shared: ["apple-docs"],
    pipeline: [
      { stage: "A", requires: [] },
      { stage: "B", requires: [] },
      { stage: "b2", requires: ["B"] },
      { stage: "b3", requires: ["b2"] },
    ],
    maxConcurrency: 2,
    budget: { retries: 2 },
  })

  test("a stalled branch's incompleteAttempts is NOT incremented by sibling-driven advances", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, AB_TAIL, "diamond stall")

    // advance 1: instruct A + B (both requires:[], 2 slots).
    const b1 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, {})
    expect(b1.instruct.map((i) => i.stage).sort()).toEqual(["A", "B"])

    // A stalls (no deliverable). B completes. Settle both via task_results:
    //   - B has a valid deliverable -> completes, b2 fans out.
    //   - A has NO deliverable -> incomplete, attempt 1 (this is A's ONE real chief run so far).
    await writeDeliverable(tmp.path, run.runID, "B")
    const b2 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, {
      taskResults: [
        { stage: "A", taskID: "ses_a1" },
        { stage: "B", taskID: "ses_b1" },
      ],
    })
    // b2 fans out; A surfaced as the incomplete blocker with exactly one attempt.
    expect(b2.instruct.map((i) => i.stage)).toEqual(["b2"])
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].status).toBe("running")
    expect(state.stages["A"].incompleteAttempts).toBe(1)
    expect(state.stages["B"].status).toBe("completed")

    // Sibling advance settling b2 (its OWN taskID). A is NOT reported this call and is not
    // pending-revise: it must be left untouched — no settle, no retryOrFail, no attempt increment.
    await writeDeliverable(tmp.path, run.runID, "b2")
    const b3 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, { taskResults: [{ stage: "b2", taskID: "ses_b2" }] })
    expect(b3.halted).toBeUndefined()
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].incompleteAttempts).toBe(1) // NOT bumped by the b2 advance
    expect(state.stages["A"].status).toBe("running")
    expect(state.status).toBe("active")

    // Sibling advance settling b3. A still untouched -> still attempt 1, still running, not halted.
    await writeDeliverable(tmp.path, run.runID, "b3")
    const b4 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, { taskResults: [{ stage: "b3", taskID: "ses_b3" }] })
    expect(b4.halted).toBeUndefined()
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].incompleteAttempts).toBe(1) // STILL not bumped: retry budget intact
    expect(state.stages["A"].status).toBe("running")
    expect(state.status).toBe("active")
  })

  test("a re-reported stalled branch DOES increment (1:1 with real chief re-runs) and fails only after budget.retries REAL re-runs", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, AB_TAIL, "diamond stall increment")

    const b1 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, {})
    expect(b1.instruct.map((i) => i.stage).sort()).toEqual(["A", "B"])

    // B completes, A stalls: A attempt 1.
    await writeDeliverable(tmp.path, run.runID, "B")
    await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, {
      taskResults: [
        { stage: "A", taskID: "ses_a1" },
        { stage: "B", taskID: "ses_b1" },
      ],
    })
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].incompleteAttempts).toBe(1)

    // The CEO re-runs A (reports it again, still no deliverable): attempt 2 (a REAL re-run).
    const reA1 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, { taskResults: [{ stage: "A", taskID: "ses_a2" }] })
    expect(reA1.halted).toBeUndefined() // retries:2 -> attempt 2 still within budget
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].incompleteAttempts).toBe(2)
    expect(state.stages["A"].status).toBe("running")

    // The CEO re-runs A a THIRD time (attempt 3 > budget.retries 2) -> fails + halts.
    const reA2 = await OrgRunner.advance(deps, tmp.path, AB_TAIL, run.runID, { taskResults: [{ stage: "A", taskID: "ses_a3" }] })
    expect(reA2.halted).toBeDefined()
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["A"].incompleteAttempts).toBe(3)
    expect(state.stages["A"].status).toBe("failed")
    expect(state.status).toBe("halted")
  })
})

// Finding #4 (minor): a revised stage's timeout must compare against the REVISE run's startedAt,
// not the original run's. decide()'s revise branch resets startedAt so an intermediate invalid
// deliverable in the revise loop is not mislabeled a timeout against a stale (first-run) start.
describe("OrgRunner revise resets startedAt for timeout correctness (Finding #4)", () => {
  test("decide('revise') sets startedAt to the decision time, so the revise run's timeout is measured from the revise start", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: { evaluation: { chief: "eval-chief", workers: ["market-research"] } },
      shared: ["apple-docs"],
      pipeline: [{ stage: "evaluation", gate: "human", timeoutMs: 1000 }],
      budget: { retries: 0 }, // retries:0 -> a single invalid settle exhausts and halts, revealing the cause word
    })
    const run = await OrgRunner.start(tmp.path, org, "idea revise clock reset")

    // A deterministic clock: the first run started far in the past.
    const firstStart = "2026-01-01T00:00:00.000Z"
    const gateNow = Date.parse("2026-01-01T01:00:00.000Z") // 1 hour after the first start

    // Drive: first run completes with a VALID deliverable -> gate.
    const gateDeps = { costOf: async () => 0.1, now: () => gateNow }
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].startedAt = firstStart
      s.stages["evaluation"].attempts = 1
    })
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const gated = await advance1(gateDeps, tmp.path, org, run.runID, { taskID: "ses_eval" })
    expect(gated.kind).toBe("gate")

    // The user waits a long time, then asks for a revise. decide must reset startedAt to "now".
    const before = await OrgState.read(tmp.path, run.runID)
    expect(before.stages["evaluation"].startedAt).toBe(firstStart) // still the stale first-run start
    await OrgRunner.decide(tmp.path, org, run.runID, "revise", "tighten it")
    const afterDecide = await OrgState.read(tmp.path, run.runID)
    // startedAt was reset to a FRESH timestamp (no longer the stale first-run start).
    expect(afterDecide.stages["evaluation"].startedAt).not.toBe(firstStart)
    const reviseStart = Date.parse(afterDecide.stages["evaluation"].startedAt!)

    // The re-instruct fires; then the revise-run chief re-emits an INVALID deliverable only 500ms
    // into the revise run — well WITHIN the 1000ms timeout measured from the reset revise start.
    // With retries:0, this single incomplete exhausts and halts; the halt REASON's cause word proves
    // whether the timeout was measured from the (reset) revise start or the stale first-run start:
    //   - fix present: 500ms < 1000ms -> NOT timed out -> "deliverable never produced".
    //   - fix absent (stale startedAt): reviseStart+500 is ~1h past firstStart -> mislabeled "timeout".
    await advance1(gateDeps, tmp.path, org, run.runID, {}) // re-instruct (clears the revise decision)
    await writeDeliverable(tmp.path, run.runID, "evaluation", "short") // invalid: too short (5 < 50)
    const withinTimeoutDeps = { costOf: async () => 0.1, now: () => reviseStart + 500 }
    const halted = await advance1(withinTimeoutDeps, tmp.path, org, run.runID, { taskID: "ses_eval_r" })
    expect(halted.kind).toBe("halted")
    if (halted.kind !== "halted") throw new Error("unreachable")
    // Because startedAt was reset, the 500ms elapsed is under the timeout: the failure is the plain
    // never-produced cause, NOT a timeout mislabel.
    expect(halted.reason).toContain("deliverable never produced")
    expect(halted.reason).not.toContain("timeout")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.haltReason).not.toContain("timeout")
  })
})

// kilocode_change - new tests (W9.3): stagePromptFor sources workerCapabilities from the roster
// (ConfigAgent.load(projectDir)) so a chief's stage prompt shows what each of its workers is good
// at. Mirrors org-template's real swiftui-dev-1 (tagged: [swiftui, ui-implementation,
// state-management]) / swiftui-dev-2 (untagged) pair from org-template/agents/, proving both the
// annotated and the back-compat-plain rendering against a REAL roster load, not a fabricated one.
const FRONTEND_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    frontend: { chief: "frontend-chief", workers: ["swiftui-dev-1", "swiftui-dev-2"] },
  },
  shared: [],
  pipeline: [{ stage: "frontend" }],
})

async function writeAgentFile(dir: string, name: string, frontmatter: string) {
  const file = path.join(dir, "agents", `${name}.md`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `---\n${frontmatter}\n---\n\nYou are ${name}.\n`)
}

describe("OrgRunner stagePromptFor capability annotation (W9.3)", () => {
  test("annotates a tagged worker's capabilities from the roster; leaves an untagged worker plain", async () => {
    await using tmp = await tmpdir()
    await writeAgentFile(
      tmp.path,
      "swiftui-dev-1",
      "mode: subagent\nmodel: anthropic/claude-sonnet-5\ncapabilities: [swiftui, ui-implementation, state-management]",
    )
    // no `capabilities:` line at all - the untagged back-compat case, mirroring the real template's swiftui-dev-2.md
    await writeAgentFile(tmp.path, "swiftui-dev-2", "mode: subagent\nmodel: anthropic/claude-sonnet-5")
    await writeAgentFile(tmp.path, "frontend-chief", "mode: subagent\nmodel: anthropic/claude-sonnet-5")
    await writeAgentFile(tmp.path, "ceo", "mode: primary\nmodel: anthropic/claude-sonnet-5")

    const run = await OrgRunner.start(tmp.path, FRONTEND_ORG, "a habit tracker for sailors")
    const result = await advance1({ costOf: async () => 0 }, tmp.path, FRONTEND_ORG, run.runID, {})
    expect(result.kind).toBe("instruct")
    if (result.kind !== "instruct") throw new Error("unreachable")
    expect(result.taskPrompt).toContain("swiftui-dev-1 (swiftui, ui-implementation, state-management)")
    // the untagged worker renders bare, not annotated
    expect(result.taskPrompt).not.toContain("swiftui-dev-2 (")
    expect(result.taskPrompt).toContain("swiftui-dev-2")
  })

  test("falls back to plain worker names when the roster has no agent files (best-effort, never breaks prompt building)", async () => {
    await using tmp = await tmpdir()
    // No agents/ directory at all - ConfigAgent.load must not throw, and the prompt still builds.
    const run = await OrgRunner.start(tmp.path, FRONTEND_ORG, "a habit tracker for sailors")
    const result = await advance1({ costOf: async () => 0 }, tmp.path, FRONTEND_ORG, run.runID, {})
    expect(result.kind).toBe("instruct")
    if (result.kind !== "instruct") throw new Error("unreachable")
    expect(result.taskPrompt).toContain("swiftui-dev-1, swiftui-dev-2")
  })
})
