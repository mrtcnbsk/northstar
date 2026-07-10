// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgAudit } from "../../../src/kilocode/organization/audit"
import { OrgState } from "../../../src/kilocode/organization/state"

describe("OrgAudit", () => {
  test("read returns [] when approvals.json is absent", async () => {
    await using tmp = await tmpdir()
    const entries = await OrgAudit.read(tmp.path, "no-such-run")
    expect(entries).toEqual([])
  })

  test("append writes the first entry to a fresh file", async () => {
    await using tmp = await tmpdir()
    await OrgAudit.append(tmp.path, "run1", {
      ts: "2026-07-09T00:00:00.000Z",
      stage: "evaluation",
      decision: "approve",
    })
    const entries = await OrgAudit.read(tmp.path, "run1")
    expect(entries).toEqual([{ ts: "2026-07-09T00:00:00.000Z", stage: "evaluation", decision: "approve" }])
  })

  test("two decisions produce two entries in order with correct fields", async () => {
    await using tmp = await tmpdir()
    await OrgAudit.append(tmp.path, "run2", {
      ts: "2026-07-09T00:00:00.000Z",
      stage: "evaluation",
      decision: "revise",
      note: "dig deeper",
      deliverableHash: "abc123",
    })
    await OrgAudit.append(tmp.path, "run2", {
      ts: "2026-07-09T00:05:00.000Z",
      stage: "evaluation",
      decision: "approve",
      deliverableHash: "def456",
    })
    const entries = await OrgAudit.read(tmp.path, "run2")
    expect(entries.length).toBe(2)
    expect(entries[0]).toEqual({
      ts: "2026-07-09T00:00:00.000Z",
      stage: "evaluation",
      decision: "revise",
      note: "dig deeper",
      deliverableHash: "abc123",
    })
    expect(entries[1]).toEqual({
      ts: "2026-07-09T00:05:00.000Z",
      stage: "evaluation",
      decision: "approve",
      deliverableHash: "def456",
    })
  })

  test("corrupted approvals.json raises a readable error naming the file", async () => {
    await using tmp = await tmpdir()
    const runID = "run3"
    const dir = OrgState.runDir(tmp.path, runID)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, "approvals.json")
    await writeFile(file, "{ not valid json ]")
    await expect(OrgAudit.read(tmp.path, runID)).rejects.toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  })

  test("path helper points at .kilo/org/runs/<runID>/approvals.json", () => {
    expect(OrgAudit.path("/proj", "run4")).toBe(path.join("/proj", ".kilo", "org", "runs", "run4", "approvals.json"))
  })
})
