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

  // A 6-record pool for Fix #4/#5. Each query term is UNIQUE to a single record (appears in
  // exactly one), so the lexical scorer never drops one as "ubiquitous" (corpus floor = 3). The
  // five eng records each match TWO query terms (score 2); the sole design record matches ONE
  // (score 1), so it deterministically ranks LAST (6th) - outside the engine's default top-5.
  const SIX_QUERY = "zephyr xylophone quokka narwhal obsidian tungsten cinnabar basalt marlin haddock wombat"
  async function seedSixPool(dir: string) {
    await OrgMemory.save(dir, { text: "The zephyr rollout needs a xylophone gate.", dept: "eng", key: "eng-1" })
    await OrgMemory.save(dir, { text: "A quokka cache precedes the narwhal migration.", dept: "eng", key: "eng-2" })
    await OrgMemory.save(dir, { text: "Guard the obsidian queue with a tungsten retry.", dept: "eng", key: "eng-3" })
    await OrgMemory.save(dir, { text: "The cinnabar worker batches basalt jobs.", dept: "eng", key: "eng-4" })
    await OrgMemory.save(dir, { text: "Route marlin traffic via the haddock proxy.", dept: "eng", key: "eng-5" })
    // The ONLY design-tagged record, and the lowest-scoring match -> ranked ~6th.
    await OrgMemory.save(dir, { text: "Audit the wombat spacing.", dept: "design", key: "design-1" })
  }

  // Fix #4: the [dept::name] post-filter used to run AFTER the engine already truncated to top-5,
  // so a matching-dept record ranked outside the top-5 was dropped and recall reported "no results"
  // though it existed. Over-fetching a wider candidate window before the post-filter recovers it.
  test("Fix #4: a dept match ranked outside the default top-5 is still found (over-fetch before post-filter)", async () => {
    const t = await tmp()
    try {
      await seedSixPool(t.dir)

      const designOnly = await OrgMemory.recall(t.dir, { query: SIX_QUERY, dept: "design" })
      expect(designOnly.hits.length).toBe(1)
      expect(designOnly.hits[0]?.text).toContain("[dept::design]")
      expect(designOnly.hits[0]?.text).toContain("wombat")
    } finally {
      await t.done()
    }
  })

  // Fix #5: recall never threaded its `limit` to the engine, which caps at its own default of 5, so
  // a caller asking for more than 5 could never receive more than 5. Threading the limit lets a
  // >5 request return >5 hits (up to the engine max of 20).
  test("Fix #5: a limit above 5 can return more than 5 hits (limit is threaded to the engine)", async () => {
    const t = await tmp()
    try {
      await seedSixPool(t.dir)

      const many = await OrgMemory.recall(t.dir, { query: SIX_QUERY, limit: 10 })
      expect(many.hits.length).toBeGreaterThan(5)
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
