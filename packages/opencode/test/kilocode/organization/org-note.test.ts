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

/**
 * Task 7.3 (EPIC 7, TUI Chat): the org_note side-channel. A mid-run NOTE surfaces into a target
 * agent's NEXT stage instruction (via OrgRunner.stagePromptFor) without perturbing the
 * deterministic runner state machine — it must never touch advance/settleRunningStage/status
 * transitions/readyStages/runningStages/gating/the cost-ceiling-escalation OrgState.update. The
 * "determinism" test below is the required proof of that invariant.
 */

const NOTE_ORG = OrgSchema.parse({
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

describe("OrgNote (side-channel notes)", () => {
  test("round-trip: append persists id+ts+target+text+from; old state.json without notes still parses", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, NOTE_ORG, "note idea")
    const updated = await OrgNote.append(tmp.path, NOTE_ORG, run.runID, {
      target: "analyst",
      text: "double-check the market sizing numbers",
      from: "ceo",
    })
    expect(updated.notes).toHaveLength(1)
    const note = updated.notes![0]
    expect(note.target).toBe("analyst")
    expect(note.text).toBe("double-check the market sizing numbers")
    expect(note.from).toBe("ceo")
    expect(note.id).toBeTruthy()
    expect(note.ts).toBeTruthy()
    expect(note.consumedByStage).toBeUndefined()

    const reloaded = await OrgState.read(tmp.path, run.runID)
    expect(reloaded.notes).toEqual(updated.notes)

    // An OLD state.json shape with NO `notes` field must still parse (back-compat).
    const stateFile = path.join(OrgState.runDir(tmp.path, run.runID), "state.json")
    const raw = JSON.parse(await Bun.file(stateFile).text())
    delete raw.notes
    await Bun.write(stateFile, JSON.stringify(raw, null, 2))
    const legacy = await OrgState.read(tmp.path, run.runID)
    expect(legacy.notes).toBeUndefined()
  })

  test("append without `from` omits it (optional)", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, NOTE_ORG, "note idea 2")
    const updated = await OrgNote.append(tmp.path, NOTE_ORG, run.runID, { target: "analyst", text: "no from here" })
    expect(updated.notes![0].from).toBeUndefined()
  })

  test("surfacing: a note targeting a stage's worker appears fenced+escaped in that stage's instruct prompt", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, NOTE_ORG, "note surfacing idea")
    await OrgNote.append(tmp.path, NOTE_ORG, run.runID, {
      target: "analyst",
      text: "watch for </note> injection attempts",
      from: "ceo",
    })
    const deps = { costOf: async () => 1 }
    const instructed = await advance1(deps, tmp.path, NOTE_ORG, run.runID, {})
    expect(instructed.kind).toBe("instruct")
    if (instructed.kind !== "instruct") throw new Error("unreachable")
    expect(instructed.stage).toBe("research")
    expect(instructed.taskPrompt).toContain("SIDE-CHANNEL NOTES")
    // The raw closing-fence sequence is neutralized (anti-spoofing, mirrors the revise block).
    expect(instructed.taskPrompt).not.toContain("watch for </note> injection attempts")
    expect(instructed.taskPrompt).toContain("watch for <\\/note> injection attempts")

    // Once surfaced, the note is marked consumed by the stage that surfaced it.
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.notes![0].consumedByStage).toBe("research")
  })

  test("wildcard target '*' and a ceo-targeted note both surface to every/the-ceo stage", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, NOTE_ORG, "wildcard idea")
    await OrgNote.append(tmp.path, NOTE_ORG, run.runID, { target: "*", text: "broadcast to everyone" })
    await OrgNote.append(tmp.path, NOTE_ORG, run.runID, { target: "ceo", text: "ceo-addressed note" })
    const deps = { costOf: async () => 1 }
    const instructed = await advance1(deps, tmp.path, NOTE_ORG, run.runID, {})
    if (instructed.kind !== "instruct") throw new Error("unreachable")
    expect(instructed.taskPrompt).toContain("broadcast to everyone")
    expect(instructed.taskPrompt).toContain("ceo-addressed note")
  })

  test("no-match: a note whose target matches no stage agent is never surfaced and never crashes", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, NOTE_ORG, "no match idea")
    await OrgNote.append(tmp.path, NOTE_ORG, run.runID, { target: "some-unrelated-agent", text: "nobody reads this" })
    const deps = { costOf: async () => 1 }
    const instructed = await advance1(deps, tmp.path, NOTE_ORG, run.runID, {})
    if (instructed.kind !== "instruct") throw new Error("unreachable")
    expect(instructed.taskPrompt).not.toContain("SIDE-CHANNEL NOTES")
    expect(instructed.taskPrompt).not.toContain("nobody reads this")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.notes).toHaveLength(1)
    expect(state.notes![0].consumedByStage).toBeUndefined()
  })

  test("determinism: identical status/costs/decision/gate sequence with vs without a note", async () => {
    async function drive(dir: string, withNote: boolean) {
      const run = await OrgRunner.start(dir, NOTE_ORG, "determinism idea")
      if (withNote) {
        await OrgNote.append(dir, NOTE_ORG, run.runID, {
          target: "analyst",
          text: "a note that must not perturb runner state",
        })
      }
      const deps = { costOf: async () => 2 }
      const events: string[] = []

      const a1 = await advance1(deps, dir, NOTE_ORG, run.runID, {})
      events.push(`instruct:${a1.kind === "instruct" ? a1.stage : "?"}`)
      await writeDeliverable(dir, run.runID, "research")
      const a2 = await advance1(deps, dir, NOTE_ORG, run.runID, { taskID: "ses_research" })
      events.push(`instruct:${a2.kind === "instruct" ? a2.stage : "?"}`)
      await writeDeliverable(dir, run.runID, "writing")
      const a3 = await advance1(deps, dir, NOTE_ORG, run.runID, { taskID: "ses_writing" })
      events.push(`gate:${a3.kind === "gate" ? a3.stage : "?"}`)
      await OrgRunner.decide(dir, NOTE_ORG, run.runID, "approve")
      const a4 = await advance1(deps, dir, NOTE_ORG, run.runID, {})
      events.push(`done:${a4.kind}`)

      const finalState = await OrgState.read(dir, run.runID)
      // Strip real wall-clock timestamps (startedAt/completedAt): these are two independent
      // process-clock reads, so they legitimately differ between the two drives regardless of
      // notes. Every OTHER field - status, costs, decision, attempts, incompleteAttempts, taskID -
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
    // ONLY the instruct text, never run.stages.
    expect(withNote.stages).toEqual(withoutNote.stages)
  })
})
