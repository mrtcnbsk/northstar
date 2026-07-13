import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgKnowledge } from "../../../src/kilocode/organization/knowledge"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"

async function managed(dir: string, name = "Studio") {
  return OrgWorkspace.stage(dir, name)
}

describe("OrgKnowledge", () => {
  test("copies department knowledge and searches it without embeddings", async () => {
    await using tmp = await tmpdir()
    const ctx = await managed(tmp.path)
    const source = path.join(tmp.path, "brief.md")
    await Bun.write(source, "Northstar launch acceptance evidence")

    const result = await OrgKnowledge.importFiles(ctx, {
      sources: ["brief.md"],
      scope: { type: "department", departmentID: "engineering" },
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.status).toBe("indexed")
    const item = result.files[0]!.item
    expect(path.dirname(item.managed)).toBe("departments/engineering")
    expect(await Bun.file(path.join(ctx.paths.knowledge, item.managed)).text()).toBe(
      "Northstar launch acceptance evidence",
    )
    expect(await Bun.file(source).text()).toBe("Northstar launch acceptance evidence")
    expect(await OrgKnowledge.search(ctx, { query: "acceptance evidence", departmentID: "engineering" })).toHaveLength(
      1,
    )
    expect(await OrgKnowledge.search(ctx, { query: "acceptance evidence", departmentID: "research" })).toEqual([])
  })

  test("makes shared knowledge visible to every department", async () => {
    await using tmp = await tmpdir()
    const ctx = await managed(tmp.path)
    await Bun.write(path.join(tmp.path, "policy.txt"), "Shared security review policy")
    await OrgKnowledge.importFiles(ctx, { sources: ["policy.txt"], scope: { type: "shared" } })

    const engineering = await OrgKnowledge.search(ctx, { query: "security policy", departmentID: "engineering" })
    const research = await OrgKnowledge.search(ctx, { query: "security policy", departmentID: "research" })

    expect(engineering[0]?.scope).toEqual({ type: "shared" })
    expect(research[0]?.scope).toEqual({ type: "shared" })
  })

  test("keeps identical source names isolated between organizations", async () => {
    await using tmp = await tmpdir()
    const alpha = await managed(tmp.path, "Alpha")
    const beta = await managed(tmp.path, "Beta")
    await Bun.write(path.join(tmp.path, "brief.md"), "alpha roadmap")
    await OrgKnowledge.importFiles(alpha, { sources: ["brief.md"], scope: { type: "shared" } })
    await Bun.write(path.join(tmp.path, "brief.md"), "beta research")
    await OrgKnowledge.importFiles(beta, { sources: ["brief.md"], scope: { type: "shared" } })

    expect(await OrgKnowledge.search(alpha, { query: "roadmap" })).toHaveLength(1)
    expect(await OrgKnowledge.search(alpha, { query: "research" })).toEqual([])
    expect(await OrgKnowledge.search(beta, { query: "research" })).toHaveLength(1)
    expect(await OrgKnowledge.search(beta, { query: "roadmap" })).toEqual([])
  })

  test("rejects workspace escapes and binary input", async () => {
    await using tmp = await tmpdir()
    const ctx = await managed(tmp.path)

    await expect(
      OrgKnowledge.importFiles(ctx, { sources: ["../secret.txt"], scope: { type: "shared" } }),
    ).rejects.toThrow("inside the workspace")
    await Bun.write(path.join(tmp.path, "binary.bin"), new Uint8Array([65, 0, 66]))
    await expect(
      OrgKnowledge.importFiles(ctx, { sources: ["binary.bin"], scope: { type: "shared" } }),
    ).rejects.toThrow("text knowledge")
    expect((await OrgKnowledge.manifest(ctx)).items).toEqual([])
  })

  test("rejects the same canonical source selected twice", async () => {
    await using tmp = await tmpdir()
    const ctx = await managed(tmp.path)
    await Bun.write(path.join(tmp.path, "brief.md"), "one source")

    await expect(
      OrgKnowledge.importFiles(ctx, {
        sources: ["brief.md", "./brief.md"],
        scope: { type: "shared" },
      }),
    ).rejects.toThrow("Duplicate knowledge source")
    expect((await OrgKnowledge.manifest(ctx)).items).toEqual([])
  })

  test("re-import replaces changed content and reports unchanged content", async () => {
    await using tmp = await tmpdir()
    const ctx = await managed(tmp.path)
    const source = path.join(tmp.path, "brief.md")
    await Bun.write(source, "first roadmap")
    const first = await OrgKnowledge.importFiles(ctx, { sources: ["brief.md"], scope: { type: "shared" } })
    const firstItem = first.files[0]!.item

    await Bun.write(source, "second roadmap with acceptance proof")
    const second = await OrgKnowledge.importFiles(ctx, { sources: ["brief.md"], scope: { type: "shared" } })
    const secondItem = second.files[0]!.item

    expect(second.files[0]?.status).toBe("indexed")
    expect(secondItem.managed).not.toBe(firstItem.managed)
    expect(await Bun.file(path.join(ctx.paths.knowledge, firstItem.managed)).exists()).toBe(false)
    expect(await OrgKnowledge.search(ctx, { query: "acceptance proof" })).toHaveLength(1)
    expect(await OrgKnowledge.search(ctx, { query: "first" })).toEqual([])

    const unchanged = await OrgKnowledge.importFiles(ctx, { sources: ["brief.md"], scope: { type: "shared" } })
    expect(unchanged.files[0]?.status).toBe("unchanged")
    expect(unchanged.files[0]?.item).toEqual(secondItem)
  })

  test("keeps local import available when optional semantic indexing fails", async () => {
    await using tmp = await tmpdir()
    const ctx = await managed(tmp.path)
    await Bun.write(path.join(tmp.path, "brief.md"), "provider free evidence")
    let semanticCalls = 0

    const result = await OrgKnowledge.importFiles(
      ctx,
      { sources: ["brief.md"], scope: { type: "shared" } },
      {
        semantic: async () => {
          semanticCalls += 1
          throw new Error("no embedding provider")
        },
      },
    )

    expect(semanticCalls).toBe(1)
    expect(result.files[0]?.status).toBe("indexed")
    expect(await OrgKnowledge.search(ctx, { query: "provider evidence" })).toHaveLength(1)
  })
})
