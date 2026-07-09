// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

async function writeDeliverable(dir: string, runID: string, stage: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
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
    expect(state.stages["evaluation"].cost).toBe(0.42)
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
})
