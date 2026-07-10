// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgAudit } from "../../../src/kilocode/organization/audit"

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
    const first = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(first.kind).toBe("instruct")
    if (first.kind !== "instruct") throw new Error("unreachable")
    expect(first.stage).toBe("evaluation")
    expect(first.chief).toBe("eval-chief")
    expect(first.taskPrompt).toContain("evaluation")

    // chief "ran" and wrote the deliverable; CEO reports the task session id
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const second = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(second.kind).toBe("gate")
    if (second.kind !== "gate") throw new Error("unreachable")
    expect(second.stage).toBe("evaluation")

    // repeated advance while awaiting approval keeps returning the gate (idempotent)
    const again = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(again.kind).toBe("gate")

    const decided = await OrgRunner.decide(tmp.path, ORG, run.runID, "no-go", "market too small")
    expect(decided.status).toBe("halted")

    const after = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(after.kind).toBe("halted")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_eval: 0.42 })
    expect(state.stages["evaluation"].taskID).toBe("ses_eval")
    expect(state.stages["planning"].status).toBe("pending")
  })

  test("approve -> second stage -> done", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea two")

    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "approve")

    const third = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(third.kind).toBe("instruct")
    if (third.kind !== "instruct") throw new Error("unreachable")
    expect(third.stage).toBe("planning")
    // prior deliverable paths are threaded into the next stage prompt
    expect(third.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run.runID, "evaluation"))

    await writeDeliverable(tmp.path, run.runID, "planning")
    const done = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_plan" })
    expect(done.kind).toBe("done")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })

  test("incomplete deliverable returns incomplete with resume id", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea three")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    const result = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(result.kind).toBe("incomplete")
    if (result.kind !== "incomplete") throw new Error("unreachable")
    expect(result.resumeTaskID).toBe("ses_eval")
    expect(result.reason).toContain("deliverable")
  })

  test("incomplete carries the full stage prompt and chief for an unresumable fresh session", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea sixteen")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    const result = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
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
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {}) // re-instruct

    const stuck = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(stuck.kind).toBe("incomplete")
    if (stuck.kind !== "incomplete") throw new Error("unreachable")
    expect(stuck.chief).toBe("eval-chief")
    expect(stuck.taskPrompt).toBeDefined()
    expect(stuck.taskPrompt).toContain("evaluation")
  })

  test("incomplete after revise carries the revise note in the fresh-session prompt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea eighteen")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "add dark mode")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {}) // re-instruct clears decision/decisionNote

    // the note must survive the re-instruct so an unresumable fresh session can still be briefed
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].reviseNote).toBe("add dark mode")

    // chief stalled: deliverable unchanged -> incomplete; the fresh-session prompt still carries the note
    const stuck = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(stuck.kind).toBe("incomplete")
    if (stuck.kind !== "incomplete") throw new Error("unreachable")
    expect(stuck.taskPrompt).toContain("REVISION REQUESTED")
    expect(stuck.taskPrompt).toContain("add dark mode")
  })

  test("revise sends the stage back to running with the note", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea four")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "check EU market too")

    const redo = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(redo.kind).toBe("instruct")
    if (redo.kind !== "instruct") throw new Error("unreachable")
    expect(redo.stage).toBe("evaluation")
    expect(redo.resumeTaskID).toBe("ses_eval")
    expect(redo.taskPrompt).toContain("check EU market too")
  })

  test("decide outside a gate fails", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea five")
    await expect(OrgRunner.decide(tmp.path, ORG, run.runID, "approve")).rejects.toThrow(/no stage awaiting/i)
  })

  test("revise with unchanged deliverable cannot re-complete", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea six")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")

    // revise cleared the stale completion timestamp
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].completedAt).toBeUndefined()
    expect(state.stages["evaluation"].reviseBaseline).toBeDefined()

    const redo = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(redo.kind).toBe("instruct")

    // the chief did nothing; the pre-revise deliverable is still on disk and still "valid"
    const stuck = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
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
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {}) // re-instruct

    await writeDeliverable(tmp.path, run.runID, "evaluation", "# revised evaluation\n\n" + "new content ".repeat(20))
    const regate = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
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
    const result = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_failed" })
    expect(result.kind).toBe("halted")
    if (result.kind !== "halted") throw new Error("unreachable")
    expect(result.reason).toContain('stage "evaluation" failed')
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("active")
    expect(state.stages["evaluation"].taskID).toBe("ses_failed")
    expect(state.stages["planning"].status).toBe("pending")
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
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {}) // completes to gate without a taskID
    const again = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_late" })
    expect(again.kind).toBe("gate")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].taskID).toBe("ses_late")
  })

  test("cost accumulates across sessions but not within a resumed session", async () => {
    await using tmp = await tmpdir()
    const costs: Record<string, number> = { ses_A: 5 }
    const costDeps = { costOf: async (id: string) => costs[id] }
    const run = await OrgRunner.start(tmp.path, ORG, "idea eleven")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5 })
    let status = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(status.totalCost).toBe(5)

    // revise; the chief RESUMES ses_A whose cumulative cost grows to 7 -> overwrite, not 5 + 7
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "more depth")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_A"] = 7
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take two\n\n" + "revised ".repeat(20))
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 7 })

    // revise again; a FRESH session ses_B costs 2 -> accumulate on top of prior spend
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "one more pass")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_B"] = 2
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take three\n\n" + "fresh ".repeat(20))
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_B" })
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
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5 })

    // revise; a DIFFERENT session ses_B completes at cost 2
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "try a different angle")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_B"] = 2
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take two\n\n" + "session b ".repeat(20))
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_B" })
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5, ses_B: 2 })

    // revise again; back to ses_A, now with cumulative cost 8 (not a fresh 5+8)
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "back to the original take")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {}) // re-instruct
    costs["ses_A"] = 8
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# take three\n\n" + "session a again ".repeat(20))
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
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
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {}) // start evaluation
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].cost = 5
      s.stages["evaluation"].costTaskID = "ses_old"
      // no `costs` map: written before per-session tracking existed
    })

    // post-upgrade, a FRESH session completes the stage at cost 2
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_new" })

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
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })

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
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })

    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "dig deeper")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {}) // re-instruct
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# revised\n\n" + "more ".repeat(20))
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" }) // back to gate
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
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_running" })

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
    const after = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
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
    await OrgRunner.advance(costDeps1, tmp.path, ORG_RUN_ONLY, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const afterEval = await OrgRunner.advance(costDeps1, tmp.path, ORG_RUN_ONLY, run.runID, { taskID: "ses_eval" })
    expect(afterEval.kind).toBe("instruct") // moved straight on to planning: no gate, no halt

    // planning stage costs 6 more: runTotal = 11 > run cap 10 -> halted (stageTotal 6 == cap 6, not tripped)
    const costDeps2 = { costOf: async () => 6 }
    await writeDeliverable(tmp.path, run.runID, "planning")
    const result = await OrgRunner.advance(costDeps2, tmp.path, ORG_RUN_ONLY, run.runID, { taskID: "ses_plan" })
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
    const again = await OrgRunner.advance(costDeps2, tmp.path, ORG_RUN_ONLY, run.runID, {})
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
    await OrgRunner.advance(costDeps, tmp.path, ORG_STAGE_OVERRIDE, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await OrgRunner.advance(costDeps, tmp.path, ORG_STAGE_OVERRIDE, run.runID, { taskID: "ses_eval" })

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
    await OrgRunner.advance(costDeps, tmp.path, BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await OrgRunner.advance(costDeps, tmp.path, BUDGET_ORG, run.runID, { taskID: "ses_eval" })

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
    const next = await OrgRunner.advance(costDeps, tmp.path, BUDGET_ORG, run.runID, {})
    expect(next.kind).toBe("instruct")
    if (next.kind !== "instruct") throw new Error("unreachable")
    expect(next.stage).toBe("planning")

    // planning stage also costs 5 -> runTotal would be 10, still >= threshold, but escalated
    // already true so it must NOT re-gate (only a hard ceiling could stop it now).
    await writeDeliverable(tmp.path, run.runID, "planning")
    const afterPlanning = await OrgRunner.advance(costDeps, tmp.path, BUDGET_ORG, run.runID, { taskID: "ses_plan" })
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
    await OrgRunner.advance(costDeps, tmp.path, GATED_BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await OrgRunner.advance(costDeps, tmp.path, GATED_BUDGET_ORG, run.runID, { taskID: "ses_eval" })

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
    await OrgRunner.advance(costDeps, tmp.path, BUDGET_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await OrgRunner.advance(costDeps, tmp.path, BUDGET_ORG, run.runID, { taskID: "ses_eval" })

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
    await OrgRunner.advance(costDeps, tmp.path, ORG_BOTH, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const result = await OrgRunner.advance(costDeps, tmp.path, ORG_BOTH, run.runID, { taskID: "ses_eval" })

    expect(result.kind).toBe("halted")
    if (result.kind !== "halted") throw new Error("unreachable")
    expect(result.reason).toContain("budget ceiling exceeded")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    // hard ceiling took precedence: escalation must not have been marked as a gate outcome
    expect(state.stages["evaluation"].status).not.toBe("awaiting_approval")
  })
})
