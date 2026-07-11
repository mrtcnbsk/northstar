// kilocode_change - new file
// W6.2: tests for OrgPostmortem.write's filesystem side - creating .kilo/org/lessons.md,
// fire-once idempotency (a marker check, not "call write once"), and multi-run appends. Mirrors
// state.ts/audit.ts's tmpdir idiom (the `tmpdir` fixture used across wave4/wave5-exit.test.ts).
import { describe, test, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgPostmortem } from "../../../src/kilocode/organization/postmortem"
import { OrgState } from "../../../src/kilocode/organization/state"
import type { OrgAudit } from "../../../src/kilocode/organization/audit"

function run(runID: string, idea: string): OrgState.Run {
  return {
    runID,
    idea,
    createdAt: "2026-07-11T12:00:00.000Z",
    status: "completed",
    stages: {
      plan: { status: "completed", attempts: 1, costs: { ses_plan: 1 }, completedAt: "2026-07-11T12:10:00.000Z" },
    },
  }
}

describe("OrgPostmortem.write", () => {
  test("creates .kilo/org/lessons.md (and the .kilo/org dir) with the built section when absent", async () => {
    await using tmp = await tmpdir()
    const r = run("20260711-120000-idea-a", "Idea A")
    const summary = OrgState.runSummary(r)
    const audit: OrgAudit.Entry[] = []

    await OrgPostmortem.write(tmp.path, r, summary, audit)

    const file = path.join(tmp.path, ".kilo", "org", "lessons.md")
    const text = await Bun.file(file).text()
    expect(text).toContain(r.runID)
    expect(text).toContain(r.idea)
    expect(text).toContain(`<!-- postmortem:${r.runID} -->`)
    expect(OrgPostmortem.lessonsPath(tmp.path)).toBe(file)
  })

  test("fire-once: writing the SAME run twice appends the section only once", async () => {
    await using tmp = await tmpdir()
    const r = run("20260711-120000-idea-b", "Idea B")
    const summary = OrgState.runSummary(r)
    const audit: OrgAudit.Entry[] = []

    await OrgPostmortem.write(tmp.path, r, summary, audit)
    const afterFirst = await Bun.file(path.join(tmp.path, ".kilo", "org", "lessons.md")).text()

    await OrgPostmortem.write(tmp.path, r, summary, audit)
    const afterSecond = await Bun.file(path.join(tmp.path, ".kilo", "org", "lessons.md")).text()

    expect(afterSecond).toBe(afterFirst) // byte-identical: the second call was a pure no-op
    const marker = `<!-- postmortem:${r.runID} -->`
    const occurrences = afterSecond.split(marker).length - 1
    expect(occurrences).toBe(1)
  })

  test("two DIFFERENT runs append two distinct sections, first-written first", async () => {
    await using tmp = await tmpdir()
    const a = run("20260711-120000-idea-a", "Idea A")
    const b = run("20260711-130000-idea-b", "Idea B")
    const summaryA = OrgState.runSummary(a)
    const summaryB = OrgState.runSummary(b)

    await OrgPostmortem.write(tmp.path, a, summaryA, [])
    await OrgPostmortem.write(tmp.path, b, summaryB, [])

    const text = await Bun.file(path.join(tmp.path, ".kilo", "org", "lessons.md")).text()
    expect(text).toContain(`<!-- postmortem:${a.runID} -->`)
    expect(text).toContain(`<!-- postmortem:${b.runID} -->`)
    // newest last: run A's marker appears before run B's marker in the file.
    expect(text.indexOf(a.runID)).toBeLessThan(text.indexOf(b.runID))
  })

  test("propagates a real write failure (does NOT silently succeed) when the destination path is unwritable", async () => {
    await using tmp = await tmpdir()
    // Pre-create a DIRECTORY at the exact lessons.md path so any read/write against it as a file fails.
    await mkdir(path.join(tmp.path, ".kilo", "org", "lessons.md"), { recursive: true })
    const r = run("20260711-120000-idea-c", "Idea C")
    const summary = OrgState.runSummary(r)

    await expect(OrgPostmortem.write(tmp.path, r, summary, [])).rejects.toBeTruthy()
  })
})
