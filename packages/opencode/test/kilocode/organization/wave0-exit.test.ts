// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgAudit } from "../../../src/kilocode/organization/audit"

/**
 * Wave 0 exit verification (W0.8): one end-to-end scenario proving the wave's exit criteria
 * hold TOGETHER, not just individually in their own unit tests.
 *
 *   - per-session cost map: distinct chief sessions across a revise cycle accumulate correctly
 *     (exercised via a 2-dept run: evaluation gate:human -> planning)
 *   - approvals.json audit: gate decisions are appended in order with ts/stage/decision fields
 *   - kill-switch: OrgRunner.stop halts an active run, records the reason, appends an audit
 *     entry, and subsequent advance short-circuits on "halted"
 *
 * Template exit criterion (58-agent roster + crossCheck + seam tests) is already covered by
 * template.test.ts; not duplicated here.
 */

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "evaluation", gate: "human" }, { stage: "planning" }],
})

async function writeDeliverable(dir: string, runID: string, stage: string, content?: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content ?? `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

describe("Wave 0 exit verification", () => {
  test("cost map, audit trail, and kill-switch hold together across one run", async () => {
    await using tmp = await tmpdir()
    const costs: Record<string, number> = { ses_A: 5 }
    const costDeps = { costOf: async (id: string) => costs[id] }

    // --- 1. start -> advance (instruct) -> write deliverable -> advance with ses_A -> gate ---
    const run = await OrgRunner.start(tmp.path, ORG, "wave 0 exit idea")

    const instructOne = await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {})
    expect(instructOne.kind).toBe("instruct")
    if (instructOne.kind !== "instruct") throw new Error("unreachable")
    expect(instructOne.stage).toBe("evaluation")
    expect(instructOne.chief).toBe("eval-chief")

    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const gateOne = await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_A" })
    expect(gateOne.kind).toBe("gate")
    if (gateOne.kind !== "gate") throw new Error("unreachable")
    expect(gateOne.stage).toBe("evaluation")

    // --- 2. decide revise "check EU" -> advance (re-instruct carries note) -> modify deliverable
    //        -> advance with ses_B -> gate again ---
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "check EU")

    const reinstruct = await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {})
    expect(reinstruct.kind).toBe("instruct")
    if (reinstruct.kind !== "instruct") throw new Error("unreachable")
    expect(reinstruct.resumeTaskID).toBe("ses_A")
    expect(reinstruct.taskPrompt).toContain("check EU")

    costs["ses_B"] = 2
    await writeDeliverable(tmp.path, run.runID, "evaluation", "# revised evaluation\n\n" + "eu market ".repeat(20))
    const gateTwo = await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, { taskID: "ses_B" })
    expect(gateTwo.kind).toBe("gate")
    if (gateTwo.kind !== "gate") throw new Error("unreachable")
    expect(gateTwo.stage).toBe("evaluation")

    // Exit criterion: per-session stage cost map, no A-B-A double counting.
    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].costs).toEqual({ ses_A: 5, ses_B: 2 })
    const statusAfterGateTwo = await OrgRunner.status(tmp.path, ORG, run.runID)
    expect(statusAfterGateTwo.totalCost).toBe(7)

    // --- 3. approvals.json now has 1 revise entry; decide approve -> 2 entries in order ---
    let entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.length).toBe(1)
    expect(entries[0]).toMatchObject({ stage: "evaluation", decision: "revise", note: "check EU" })
    expect(typeof entries[0].ts).toBe("string")

    await OrgRunner.decide(tmp.path, ORG, run.runID, "approve")

    entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.length).toBe(2)
    expect(entries[0]).toMatchObject({ stage: "evaluation", decision: "revise", note: "check EU" })
    expect(entries[1]).toMatchObject({ stage: "evaluation", decision: "approve" })
    expect(typeof entries[1].ts).toBe("string")
    expect(new Date(entries[0].ts).getTime()).toBeLessThanOrEqual(new Date(entries[1].ts).getTime())

    // --- 4. advance -> planning instruct; then stop(..., "user emergency") -> halted,
    //        audit gains a stop entry, subsequent advance returns halted-kind ---
    const instructPlanning = await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {})
    expect(instructPlanning.kind).toBe("instruct")
    if (instructPlanning.kind !== "instruct") throw new Error("unreachable")
    expect(instructPlanning.stage).toBe("planning")
    expect(instructPlanning.chief).toBe("planning-chief")

    const stopped = await OrgRunner.stop(tmp.path, ORG, run.runID, "user emergency")
    expect(stopped.run.status).toBe("halted")
    expect(stopped.run.haltReason).toBe("emergency stop: user emergency")
    expect(stopped.stage).toBe("planning")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.haltReason).toBe("emergency stop: user emergency")

    entries = await OrgAudit.read(tmp.path, run.runID)
    expect(entries.length).toBe(3)
    expect(entries[2]).toMatchObject({ stage: "planning", decision: "stop", note: "user emergency" })

    const afterStop = await OrgRunner.advance(costDeps, tmp.path, ORG, run.runID, {})
    expect(afterStop.kind).toBe("halted")
    if (afterStop.kind !== "halted") throw new Error("unreachable")
    expect(afterStop.reason).toBe("emergency stop: user emergency")
  })
})
