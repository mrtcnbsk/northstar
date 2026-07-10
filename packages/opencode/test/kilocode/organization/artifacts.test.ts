import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"

describe("OrgArtifacts", () => {
  test("deliverablePath is stable and project-relative displayable", async () => {
    const p = OrgArtifacts.deliverablePath("/proj", "run1", "evaluation")
    expect(p).toBe(path.join("/proj", ".kilo", "org", "runs", "run1", "deliverables", "evaluation.md"))
  })

  test("validate fails when missing", async () => {
    await using tmp = await tmpdir()
    const result = await OrgArtifacts.validate(tmp.path, "run1", "evaluation")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("not found")
  })

  test("validate rejects on non-ENOENT read errors instead of reporting not found", async () => {
    await using tmp = await tmpdir()
    const file = OrgArtifacts.deliverablePath(tmp.path, "run1", "evaluation")
    // A directory at the deliverable path fails to read with EISDIR, not ENOENT.
    await mkdir(file, { recursive: true })
    await expect(OrgArtifacts.validate(tmp.path, "run1", "evaluation")).rejects.toThrow("Failed to read deliverable")
  })

  test("validate fails when too short", async () => {
    await using tmp = await tmpdir()
    const file = OrgArtifacts.deliverablePath(tmp.path, "run1", "evaluation")
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "short")
    const result = await OrgArtifacts.validate(tmp.path, "run1", "evaluation")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("short")
  })

  test("validate passes a real deliverable", async () => {
    await using tmp = await tmpdir()
    const file = OrgArtifacts.deliverablePath(tmp.path, "run1", "evaluation")
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "# Evaluation Report\n\n" + "Market looks viable because ".repeat(10))
    const result = await OrgArtifacts.validate(tmp.path, "run1", "evaluation")
    expect(result.ok).toBe(true)
  })
})
