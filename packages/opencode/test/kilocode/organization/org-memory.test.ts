// kilocode_change - new file
// W6.1: org-scoped shared memory pool. Mirrors kilo-memory/test/memory.test.ts's tmpdir-root
// idiom (mkdtemp -> save/enable -> recall, assert on returned hits) but exercises OrgMemory, the
// thin org-rooted wrapper around the SAME Memory.* facade. No embedder key anywhere: recall is
// pure lexical.
import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "fs/promises"
import os from "os"
import path from "path"
import { Memory } from "@kilocode/kilo-memory/memory"
import { MemoryPaths } from "@kilocode/kilo-memory/paths"
import { OrgMemory } from "../../../src/kilocode/organization/memory"

async function tmp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "org-memory-"))
  return {
    dir,
    async done() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe("OrgMemory", () => {
  test("root is <projectDir>/.kilo/org/memory", async () => {
    const t = await tmp()
    try {
      expect(OrgMemory.root(t.dir)).toBe(path.join(t.dir, ".kilo", "org", "memory"))
    } finally {
      await t.done()
    }
  })

  test("saves dept-tagged lessons and recalls them by lexical query", async () => {
    const t = await tmp()
    try {
      await OrgMemory.save(t.dir, { text: "Ship gate needs a budget check before prod release.", dept: "eng" })
      await OrgMemory.save(t.dir, {
        text: "Ship gate copy needs a localization review before prod release.",
        dept: "design",
      })

      const both = await OrgMemory.recall(t.dir, { query: "ship gate prod release" })
      expect(both.hits.length).toBe(2)
    } finally {
      await t.done()
    }
  })

  test("dept filter narrows recall to the matching department", async () => {
    const t = await tmp()
    try {
      await OrgMemory.save(t.dir, { text: "Ship gate needs a budget check before prod release.", dept: "eng" })
      await OrgMemory.save(t.dir, {
        text: "Ship gate copy needs a localization review before prod release.",
        dept: "design",
      })

      const engOnly = await OrgMemory.recall(t.dir, { query: "ship gate prod release", dept: "eng" })
      expect(engOnly.hits.length).toBe(1)
      expect(engOnly.hits[0]?.text).toContain("[dept::eng]")
      expect(engOnly.hits[0]?.text).toContain("budget check")

      const designOnly = await OrgMemory.recall(t.dir, { query: "ship gate prod release", dept: "design" })
      expect(designOnly.hits.length).toBe(1)
      expect(designOnly.hits[0]?.text).toContain("[dept::design]")
      expect(designOnly.hits[0]?.text).toContain("localization review")
    } finally {
      await t.done()
    }
  })

  test("recall on an empty org pool returns a clean empty result without throwing", async () => {
    const t = await tmp()
    try {
      const result = await OrgMemory.recall(t.dir, { query: "anything at all" })
      expect(result.hits).toEqual([])
      expect(result.files).toEqual([])
      expect(result.topics).toEqual([])
    } finally {
      await t.done()
    }
  })

  test("the org root is created lazily and isolated from a session-memory root", async () => {
    const t = await tmp()
    try {
      const sessionRoot = path.join(t.dir, "session-memory-root")
      await Memory.enable({ root: sessionRoot })
      await Memory.remember({ root: sessionRoot, text: "Session-only note about a local dev shortcut." })

      await OrgMemory.save(t.dir, { text: "Org-only lesson about the release pipeline." })

      const orgRoot = OrgMemory.root(t.dir)
      expect(orgRoot).not.toBe(sessionRoot)

      // org recall never sees the session-memory entry
      const orgRecall = await OrgMemory.recall(t.dir, { query: "local dev shortcut release pipeline" })
      expect(orgRecall.hits.some((hit) => hit.text.includes("release pipeline"))).toBe(true)
      expect(orgRecall.hits.some((hit) => hit.text.includes("local dev shortcut"))).toBe(false)

      // session-memory recall never sees the org entry
      const sessionRecall = await Memory.recall({ root: sessionRoot, query: "local dev shortcut release pipeline" })
      const sessionHits = "hits" in sessionRecall ? (sessionRecall.hits ?? []) : []
      expect(sessionHits.some((hit) => hit.text.includes("local dev shortcut"))).toBe(true)
      expect(sessionHits.some((hit) => hit.text.includes("release pipeline"))).toBe(false)

      // writing org memory never touched the session-memory project.md
      const sessionProject = await readFile(MemoryPaths.files(sessionRoot).project, "utf8")
      expect(sessionProject).toContain("local dev shortcut")
      expect(sessionProject).not.toContain("release pipeline")
    } finally {
      await t.done()
    }
  })

  test("limit caps the number of returned hits", async () => {
    const t = await tmp()
    try {
      // Only 2 distinct records on purpose: the lexical scorer drops any term shared by >= 3
      // records in the corpus as "ubiquitous" (recall/topics.ts corpus.floor=3), which would zero
      // out a shared query term once a 3rd near-identical record joins the pool. Two records keeps
      // "deploy checklist" a valid, non-dropped, matching term for both.
      await OrgMemory.save(t.dir, {
        text: "Deploy checklist: verify staging smoke tests pass before promoting.",
        dept: "eng",
        key: "deploy-checklist-smoke",
      })
      await OrgMemory.save(t.dir, {
        text: "Deploy checklist: rotate signing certificates before submission.",
        dept: "eng",
        key: "deploy-checklist-certs",
      })

      const unlimited = await OrgMemory.recall(t.dir, { query: "deploy checklist" })
      expect(unlimited.hits.length).toBe(2)

      const limited = await OrgMemory.recall(t.dir, { query: "deploy checklist", limit: 1 })
      expect(limited.hits.length).toBe(1)
    } finally {
      await t.done()
    }
  })
})
