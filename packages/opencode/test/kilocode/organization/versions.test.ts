import { describe, test, expect } from "bun:test"
import path from "path"
import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgVersions } from "../../../src/kilocode/organization/versions"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"

const RUN_ID = "run1"
const STAGE = "evaluation"

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function writeDeliverable(projectDir: string, text: string) {
  const file = OrgArtifacts.deliverablePath(projectDir, RUN_ID, STAGE)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
  return file
}

describe("OrgVersions", () => {
  test("snapshot returns undefined when the live deliverable is absent (ENOENT)", async () => {
    await using tmp = await tmpdir()
    const result = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    expect(result).toBeUndefined()
  })

  test("snapshot writes <sha256>.md content + a manifest entry", async () => {
    await using tmp = await tmpdir()
    const text = "# Evaluation\n\n" + "content ".repeat(20)
    await writeDeliverable(tmp.path, text)

    const result = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    expect(result).toBeDefined()
    expect(result?.hash).toBe(hashOf(text))

    const versionFile = path.join(
      tmp.path,
      ".kilo",
      "org",
      "runs",
      RUN_ID,
      "deliverables.versions",
      STAGE,
      `${hashOf(text)}.md`,
    )
    expect(await Bun.file(versionFile).text()).toBe(text)

    const list = await OrgVersions.list(tmp.path, RUN_ID, STAGE)
    expect(list).toHaveLength(1)
    expect(list[0]?.hash).toBe(hashOf(text))
    expect(list[0]?.path).toBe(versionFile)
    expect(typeof list[0]?.ts).toBe("string")
    expect(new Date(list[0]!.ts).toString()).not.toBe("Invalid Date")
  })

  test("snapshot is idempotent on identical content: no duplicate manifest entry", async () => {
    await using tmp = await tmpdir()
    const text = "# Evaluation\n\n" + "identical content ".repeat(20)
    await writeDeliverable(tmp.path, text)

    const first = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    const second = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    expect(second).toEqual(first)

    const list = await OrgVersions.list(tmp.path, RUN_ID, STAGE)
    expect(list).toHaveLength(1)
  })

  test("snapshot called after content changes appends a second distinct manifest entry", async () => {
    await using tmp = await tmpdir()
    const textA = "# Evaluation A\n\n" + "content a ".repeat(20)
    await writeDeliverable(tmp.path, textA)
    await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)

    const textB = "# Evaluation B\n\n" + "content b ".repeat(20)
    await writeDeliverable(tmp.path, textB)
    await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)

    const list = await OrgVersions.list(tmp.path, RUN_ID, STAGE)
    expect(list).toHaveLength(2)
    expect(list[0]?.hash).toBe(hashOf(textA))
    expect(list[1]?.hash).toBe(hashOf(textB))
  })

  test("list returns [] when nothing was ever snapshotted", async () => {
    await using tmp = await tmpdir()
    const list = await OrgVersions.list(tmp.path, RUN_ID, STAGE)
    expect(list).toEqual([])
  })

  test("diff produces a unified patch between two snapshotted versions", async () => {
    await using tmp = await tmpdir()
    const textA = "line one\nline two\nline three\n"
    await writeDeliverable(tmp.path, textA)
    const snapA = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)

    const textB = "line one\nline TWO CHANGED\nline three\n"
    await writeDeliverable(tmp.path, textB)
    const snapB = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)

    const patch = await OrgVersions.diff(tmp.path, RUN_ID, STAGE, snapA!.hash, snapB!.hash)
    expect(patch).toContain("-line two")
    expect(patch).toContain("+line TWO CHANGED")
  })

  test("diff throws a clear error for an unknown hash", async () => {
    await using tmp = await tmpdir()
    const text = "line one\n"
    await writeDeliverable(tmp.path, text)
    const snap = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    await expect(OrgVersions.diff(tmp.path, RUN_ID, STAGE, snap!.hash, "deadbeef")).rejects.toThrow()
  })

  test("rollback restores exact prior bytes and is NON-DESTRUCTIVE (roll-forward stays possible)", async () => {
    await using tmp = await tmpdir()
    const textA = "# Version A\n\n" + "original content ".repeat(20)
    await writeDeliverable(tmp.path, textA)
    const snapA = await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    expect(snapA).toBeDefined()

    // The chief overwrites the live deliverable in place (the real-world mechanism per the task
    // brief) WITHOUT anything snapshotting content B first - this is the "no prior content is
    // retained anywhere today" gap OrgVersions closes. list() has only A's entry at this point.
    const textB = "# Version B\n\n" + "replacement content ".repeat(20)
    await writeDeliverable(tmp.path, textB)
    const beforeRollback = await OrgVersions.list(tmp.path, RUN_ID, STAGE)
    expect(beforeRollback).toHaveLength(1)

    const result = await OrgVersions.rollback(tmp.path, RUN_ID, STAGE, snapA!.hash)
    expect(result.restoredHash).toBe(snapA!.hash)

    // The LIVE deliverable now has version A's exact bytes.
    const liveFile = OrgArtifacts.deliverablePath(tmp.path, RUN_ID, STAGE)
    expect(await Bun.file(liveFile).text()).toBe(textA)

    // NON-DESTRUCTIVE: rollback snapshotted version B's content BEFORE overwriting it, so it was
    // not lost - list() grew to 2 entries (A, B) and B's content is still fetchable byte-for-byte.
    const afterRollback = await OrgVersions.list(tmp.path, RUN_ID, STAGE)
    expect(afterRollback).toHaveLength(2)
    const hashes = afterRollback.map((e) => e.hash)
    expect(hashes).toContain(hashOf(textA))
    expect(hashes).toContain(hashOf(textB))

    const preservedB = afterRollback.find((e) => e.hash === hashOf(textB))
    expect(preservedB).toBeDefined()
    expect(await Bun.file(preservedB!.path).text()).toBe(textB)

    // Roll-forward: rolling back to B's hash restores B's exact bytes again.
    const rollForward = await OrgVersions.rollback(tmp.path, RUN_ID, STAGE, hashOf(textB))
    expect(rollForward.restoredHash).toBe(hashOf(textB))
    expect(await Bun.file(liveFile).text()).toBe(textB)
  })

  test("rollback throws a clear error for an unknown version hash", async () => {
    await using tmp = await tmpdir()
    await writeDeliverable(tmp.path, "# Some content\n\n" + "filler ".repeat(20))
    await OrgVersions.snapshot(tmp.path, RUN_ID, STAGE)
    await expect(OrgVersions.rollback(tmp.path, RUN_ID, STAGE, "0123456789abcdef")).rejects.toThrow(/unknown/i)
  })
})
