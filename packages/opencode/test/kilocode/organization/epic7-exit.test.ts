// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgState, OrgNote } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { advance1 } from "./batch-adapter"
import { parseGate } from "../../../src/kilocode/cli/cmd/tui/gate-card"

/**
 * EPIC 7 (TUI Chat) EXIT TEST (Task 7.5): one end-to-end scenario proving the three pieces EPIC 7
 * built work TOGETHER on a real pipeline, not just in their own unit tests:
 *
 *  (a) the org_note side-channel (7.3, org-note.test.ts): a mid-run note targeting a stage's
 *      worker surfaces read-only, fenced, inside that stage's NEXT instruct prompt
 *      (OrgRunner.stagePromptFor).
 *  (b) the gate flow: a `gate:"human"` stage settles to `awaiting_approval`
 *      (OrgState.runSummary/awaitingStages), and `OrgRunner.decide(dir, org, runID, "approve")` -
 *      the EXACT call the TUI's inline gate card (7.4) makes on "approve" - clears it and lets the
 *      pipeline progress to done.
 *  (c) determinism (the load-bearing invariant from 7.3): the SAME pipeline driven with and
 *      without the note produces byte-identical stage status/costs/decisions and the same
 *      instruct/gate/done event sequence - the note is inert to the machine, it only changes prompt
 *      text.
 *  (d) the gate-card parser (7.4, gate-card.test.ts) ties to a REAL gate: the `GateItem` a live
 *      `OrgRunner.advance` call actually returns for the gated stage is wrapped in the exact JSON
 *      body `tools.ts`'s `OrgAdvanceTool` would emit (gatePayload + result()'s 2-space-indent
 *      JSON.stringify), fed into `parseGate` as a ToolPart, and the resulting card is checked
 *      against that same real GateItem - including the 7.4 finding that `run_id` is never echoed
 *      back by org_advance, so `card.runID` stays undefined.
 */

const EPIC7_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    research: { chief: "research-chief", workers: ["analyst"] },
    writing: { chief: "writing-chief", workers: ["writer"] },
  },
  pipeline: [{ stage: "research" }, { stage: "writing", gate: "human" }],
})

async function writeDeliverable(dir: string, runID: string, stage: string, content?: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, content ?? `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

/**
 * Mirrors tools.ts's `gatePayload` helper (~L287-298 in src/kilocode/organization/tools.ts)
 * EXACTLY: the shape `OrgAdvanceTool` builds for a standalone `human_gate` action from a real
 * `OrgRunner.GateItem`. Kept local (rather than exported from tools.ts, which pulls in the full
 * Effect/Tool machinery) so this test can build the REAL wire body around a REAL GateItem without
 * standing up the whole tool-execution stack - matching the pattern gate-card.test.ts's own doc
 * comment describes.
 */
function gatePayload(gate: OrgRunner.GateItem) {
  const baseInstructions =
    "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision."
  return {
    stage: gate.stage,
    deliverable: gate.deliverablePath,
    ...(gate.note ? { budget_note: gate.note } : {}),
    instructions: gate.note
      ? `${baseInstructions} This gate was triggered by budget: ${gate.note}. Tell the user the cumulative spend before asking for a decision.`
      : baseInstructions,
  }
}

describe("EPIC 7 exit: side-channel note + gate flow + gate-card parser", () => {
  test("(a) a note targeting the research stage's worker surfaces fenced in its instruct prompt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, EPIC7_ORG, "epic7 exit idea")
    await OrgNote.append(tmp.path, EPIC7_ORG, run.runID, {
      target: "analyst",
      text: "prefer SwiftData",
      from: "ceo",
    })
    const deps = { costOf: async () => 1 }
    const instructed = await advance1(deps, tmp.path, EPIC7_ORG, run.runID, {})
    expect(instructed.kind).toBe("instruct")
    if (instructed.kind !== "instruct") throw new Error("unreachable")
    expect(instructed.stage).toBe("research")
    expect(instructed.taskPrompt).toContain("SIDE-CHANNEL NOTES")
    expect(instructed.taskPrompt).toContain("<note")
    expect(instructed.taskPrompt).toContain("prefer SwiftData")
    expect(instructed.taskPrompt).toContain("</note>")

    // Once surfaced, the note is marked consumed by the stage that surfaced it.
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.notes![0].consumedByStage).toBe("research")
  })

  test("(b) gate settles to awaiting_approval -> OrgRunner.decide(approve) clears it -> pipeline reaches done", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, EPIC7_ORG, "epic7 exit gate idea")
    const deps = { costOf: async () => 1 }

    const instructResearch = await advance1(deps, tmp.path, EPIC7_ORG, run.runID, {})
    expect(instructResearch.kind).toBe("instruct")
    await writeDeliverable(tmp.path, run.runID, "research")

    const instructWriting = await advance1(deps, tmp.path, EPIC7_ORG, run.runID, { taskID: "ses_research" })
    expect(instructWriting.kind).toBe("instruct")
    if (instructWriting.kind !== "instruct") throw new Error("unreachable")
    expect(instructWriting.stage).toBe("writing")
    await writeDeliverable(tmp.path, run.runID, "writing")

    const gated = await advance1(deps, tmp.path, EPIC7_ORG, run.runID, { taskID: "ses_writing" })
    expect(gated.kind).toBe("gate")
    if (gated.kind !== "gate") throw new Error("unreachable")
    expect(gated.stage).toBe("writing")

    let state = await OrgState.read(tmp.path, run.runID)
    expect(OrgState.runSummary(state).awaitingGate).toBe(true)
    expect(OrgState.awaitingStages(EPIC7_ORG, state)).toEqual(["writing"])

    // The exact call the CEO's TUI-driven message makes on the inline gate card's "approve".
    await OrgRunner.decide(tmp.path, EPIC7_ORG, run.runID, "approve")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["writing"].status).toBe("completed")
    expect(state.stages["writing"].decision).toBe("approve")
    expect(OrgState.runSummary(state).awaitingGate).toBe(false)

    // A subsequent advance progresses the run: "writing" was the last pipeline stage, so it's done.
    const advanced = await advance1(deps, tmp.path, EPIC7_ORG, run.runID, {})
    expect(advanced.kind).toBe("done")
    state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })

  test("(c) determinism: identical status/costs/decision + instruct/gate/done sequence with vs without the note", async () => {
    async function drive(dir: string, withNote: boolean) {
      const run = await OrgRunner.start(dir, EPIC7_ORG, "epic7 exit determinism idea")
      if (withNote) {
        await OrgNote.append(dir, EPIC7_ORG, run.runID, {
          target: "analyst",
          text: "a note that must not perturb runner state",
        })
      }
      const deps = { costOf: async () => 2 }
      const events: string[] = []

      const a1 = await advance1(deps, dir, EPIC7_ORG, run.runID, {})
      events.push(`instruct:${a1.kind === "instruct" ? a1.stage : "?"}`)
      await writeDeliverable(dir, run.runID, "research")
      const a2 = await advance1(deps, dir, EPIC7_ORG, run.runID, { taskID: "ses_research" })
      events.push(`instruct:${a2.kind === "instruct" ? a2.stage : "?"}`)
      await writeDeliverable(dir, run.runID, "writing")
      const a3 = await advance1(deps, dir, EPIC7_ORG, run.runID, { taskID: "ses_writing" })
      events.push(`gate:${a3.kind === "gate" ? a3.stage : "?"}`)
      await OrgRunner.decide(dir, EPIC7_ORG, run.runID, "approve")
      const a4 = await advance1(deps, dir, EPIC7_ORG, run.runID, {})
      events.push(`done:${a4.kind}`)

      const finalState = await OrgState.read(dir, run.runID)
      // Strip real wall-clock timestamps (startedAt/completedAt): these are two independent
      // process-clock reads, so they legitimately differ between the two drives regardless of the
      // note. Every OTHER field - status, costs, decision, attempts, incompleteAttempts, taskID -
      // must be byte-identical; that's what this test is actually pinning.
      const stages = Object.fromEntries(
        Object.entries(finalState.stages).map(([stage, s]) => {
          const { startedAt: _startedAt, completedAt: _completedAt, ...rest } = s
          return [stage, rest]
        }),
      )
      return {
        events,
        stages,
        status: finalState.status,
        escalated: finalState.escalated,
        haltReason: finalState.haltReason,
      }
    }

    await using tmpA = await tmpdir()
    await using tmpB = await tmpdir()
    const withNote = await drive(tmpA.path, true)
    const withoutNote = await drive(tmpB.path, false)

    expect(withNote.events).toEqual(withoutNote.events)
    expect(withNote.status).toEqual(withoutNote.status)
    expect(withNote.escalated).toEqual(withoutNote.escalated)
    expect(withNote.haltReason).toEqual(withoutNote.haltReason)
    // The full per-stage record (status, costs, decision, attempts) is identical: the note changes
    // ONLY the instruct prompt text, never run.stages.
    expect(withNote.stages).toEqual(withoutNote.stages)
  })

  test("(d) parseGate extracts the real GateItem from a live org_advance gate on the writing stage", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, EPIC7_ORG, "epic7 exit gate-card idea")
    const deps = { costOf: async () => 1 }

    await OrgRunner.advance(deps, tmp.path, EPIC7_ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "research")
    await OrgRunner.advance(deps, tmp.path, EPIC7_ORG, run.runID, { taskID: "ses_research" })
    await writeDeliverable(tmp.path, run.runID, "writing")
    const batch = await OrgRunner.advance(deps, tmp.path, EPIC7_ORG, run.runID, { taskID: "ses_writing" })

    // LOAD-BEARING: a REAL GateItem from a REAL advance call, not a hand-built fixture.
    expect(batch.gate).toBeDefined()
    const gate = batch.gate!
    expect(gate.stage).toBe("writing")
    expect(gate.note).toBeUndefined() // no budget escalation in this scenario: gate is plain gate:"human"

    // The exact wire body tools.ts's OrgAdvanceTool would return for this gate: result()
    // JSON.stringifies the body with 2-space indent (see tools.ts's `result` + the standalone
    // `batch.gate` branch: `result(..., { action: "human_gate", ...gatePayload(batch.gate) })`).
    const output = JSON.stringify({ action: "human_gate", ...gatePayload(gate) }, null, 2)
    const part = { tool: "org_advance", state: { status: "completed", output } }

    const card = parseGate(part)
    expect(card).toBeDefined()
    expect(card!.stage).toBe("writing")
    expect(card!.deliverable).toBe(gate.deliverablePath)
    expect(card!.budgetNote).toBeUndefined()
    // The 7.4 finding: org_advance's human_gate payload never echoes run_id back, so parseGate -
    // even though it defensively maps run_id -> runID - has nothing to map here.
    expect(card!.runID).toBeUndefined()
  })
})
