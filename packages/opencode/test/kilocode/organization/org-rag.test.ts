// kilocode_change - new file
// W6.3: org-scoped RAG over run deliverables. Mirrors kilo-indexing's
// search-service.test.ts pattern: a hand-rolled mock IEmbedder (deterministic, hash-based so
// query<->doc similarity is controllable) + a mock in-memory IVectorStore (trivial cosine +
// directoryPrefix filter mirroring LanceDBVectorStore's `filePath LIKE 'prefix%'` semantics),
// both injected into OrgRag - no key, no real LanceDB.
import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import type { EmbedderInfo, IEmbedder, IVectorStore, PointStruct, VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { tmpdir } from "../../fixture/fixture"
import { OrgRag } from "../../../src/kilocode/organization/rag"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"

// --- deterministic, key-free stub embedder -----------------------------------------------
// Feature-hashes tokens into a small fixed-width vector so cosine similarity reflects shared
// vocabulary between query and doc text, WITHOUT any real embedding model or API key.
const DIMS = 32

function vectorize(text: string): number[] {
  const vec = new Array(DIMS).fill(0)
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  for (const word of words) {
    let h = 0
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    vec[h % DIMS] += 1
  }
  return vec
}

function stubEmbedder(calls: string[][] = []): IEmbedder {
  return {
    async createEmbeddings(texts) {
      calls.push(texts)
      return { embeddings: texts.map(vectorize) }
    },
    async validateConfiguration() {
      return { valid: true }
    },
    get embedderInfo(): EmbedderInfo {
      return { name: "openai" }
    },
  }
}

function throwingEmbedder(): IEmbedder {
  return {
    async createEmbeddings() {
      throw new Error("no API key configured")
    },
    async validateConfiguration() {
      return { valid: false, error: "no API key configured" }
    },
    get embedderInfo(): EmbedderInfo {
      return { name: "openai" }
    },
  }
}

// --- in-memory mock vector store, mirroring LanceDBVectorStore's directoryPrefix semantics --
function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function memoryStore(): IVectorStore & { points: PointStruct[] } {
  const points: PointStruct[] = []
  const store = {
    points,
    async upsertPoints(pts: PointStruct[]) {
      points.push(...pts)
    },
    async search(queryVector: number[], directoryPrefix?: string, minScore?: number, maxResults?: number) {
      const scored = points
        .filter((p) => !directoryPrefix || String(p.payload.filePath).startsWith(directoryPrefix))
        .map((p) => ({ id: p.id, score: cosine(queryVector, p.vector), payload: p.payload }))
        .filter((r) => (minScore === undefined ? true : r.score >= minScore))
        .sort((a, b) => b.score - a.score)
      return (maxResults !== undefined ? scored.slice(0, maxResults) : scored) as VectorStoreSearchResult[]
    },
  }
  return store as unknown as IVectorStore & { points: PointStruct[] }
}

// The exact required-key set enforced by LanceDBVectorStore.isPayloadValid (see
// packages/kilo-indexing/src/indexing/vector-store/lancedb-vector-store.ts). Any point whose
// payload is missing ANY of these is silently dropped by the REAL store's upsertPoints.
const ISPAYLOADVALID_REQUIRED = ["filePath", "fileHash", "codeChunk", "startLine", "endLine"] as const

// A store that ENFORCES isPayloadValid exactly like LanceDBVectorStore.upsertPoints's `valids`
// filter: a point missing any required key is dropped rather than stored. This is the real-store
// contract the plain memoryStore() above does NOT model (it stores anything), which is what let
// the missing-fileHash bug hide against the in-memory stub.
function enforcingStore(): IVectorStore & { points: PointStruct[] } {
  const points: PointStruct[] = []
  const valid = (payload: Record<string, unknown> | null | undefined) =>
    !!payload && ISPAYLOADVALID_REQUIRED.every((key) => key in payload)
  const store = {
    points,
    async upsertPoints(pts: PointStruct[]) {
      points.push(...pts.filter((p) => valid(p.payload)))
    },
    async search(queryVector: number[], directoryPrefix?: string, minScore?: number, maxResults?: number) {
      const scored = points
        .filter((p) => !directoryPrefix || String(p.payload.filePath).startsWith(directoryPrefix))
        .map((p) => ({ id: p.id, score: cosine(queryVector, p.vector), payload: p.payload }))
        .filter((r) => (minScore === undefined ? true : r.score >= minScore))
        .sort((a, b) => b.score - a.score)
      return (maxResults !== undefined ? scored.slice(0, maxResults) : scored) as VectorStoreSearchResult[]
    },
  }
  return store as unknown as IVectorStore & { points: PointStruct[] }
}

async function seedDeliverable(projectDir: string, runID: string, stage: string, text: string) {
  const file = OrgArtifacts.deliverablePath(projectDir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
}

const EVAL_DOC = `# Evaluation

The feasibility gate looks strong: offline-first, on-device inference, no network dependency.

## Risks

The edge gate is weaker; several competitors already ship similar on-device privacy features.
`

const ENG_DOC = `# Engineering Plan

The Rust hash-chained ledger stores transactions locally with SwiftUI as the front end.

## Testing

Unit tests cover the ledger's append-only invariant and the chain verification routine.
`

describe("OrgRag.chunk", () => {
  test("splits markdown into paragraph chunks with correct 1-based line ranges", () => {
    const chunks = OrgRag.chunk("para one\nstill one\n\npara two\n\n\npara three")
    expect(chunks).toEqual([
      { text: "para one\nstill one", startLine: 1, endLine: 2 },
      { text: "para two", startLine: 4, endLine: 4 },
      { text: "para three", startLine: 7, endLine: 7 },
    ])
  })

  test("ignores blank-only content", () => {
    expect(OrgRag.chunk("\n\n   \n")).toEqual([])
  })
})

describe("OrgRag.indexDeliverables", () => {
  test("upserts points carrying runID/stage in payload for every run's deliverables", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = memoryStore()
    const result = await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    expect(result.indexed).toBeGreaterThan(0)
    expect(store.points.length).toBe(result.indexed)
    const runIDs = new Set(store.points.map((p) => p.payload["runID"]))
    const stages = new Set(store.points.map((p) => p.payload["stage"]))
    expect(runIDs).toEqual(new Set(["run-eval", "run-eng"]))
    expect(stages).toEqual(new Set(["evaluation", "engineering"]))
    for (const point of store.points) {
      expect(typeof point.payload["filePath"]).toBe("string")
      expect(typeof point.payload["codeChunk"]).toBe("string")
      expect(typeof point.payload["startLine"]).toBe("number")
      expect(typeof point.payload["endLine"]).toBe("number")
    }
  })

  test("is a no-op when no runs exist", async () => {
    await using tmp = await tmpdir()
    const store = memoryStore()
    const result = await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)
    expect(result.indexed).toBe(0)
    expect(store.points.length).toBe(0)
  })

  // Fix #1: every point must carry the FULL isPayloadValid required-key set (fileHash was missing,
  // so the real LanceDB store silently dropped every org point — valids.length === 0).
  test("every indexed point payload contains fileHash and the full isPayloadValid required-key set", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = memoryStore()
    const result = await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    expect(result.indexed).toBeGreaterThan(0)
    for (const point of store.points) {
      for (const key of ISPAYLOADVALID_REQUIRED) {
        expect(point.payload[key]).toBeDefined()
        expect(key in point.payload).toBe(true)
      }
      // fileHash specifically: a stable non-empty content hash.
      expect(typeof point.payload["fileHash"]).toBe("string")
      expect((point.payload["fileHash"] as string).length).toBeGreaterThan(0)
    }
  })

  // Fix #1 (RED before fix): against a store that ENFORCES isPayloadValid like the real
  // LanceDBVectorStore, points were dropped (valids.length === 0). With fileHash present they are
  // ACCEPTED — points.length now equals indexed instead of 0.
  test("an isPayloadValid-enforcing store (mirroring LanceDBVectorStore) ACCEPTS every indexed point", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = enforcingStore()
    const result = await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    expect(result.indexed).toBeGreaterThan(0)
    // Not one point was dropped by the real-store filter: acceptance == everything indexed.
    expect(store.points.length).toBe(result.indexed)
  })
})

describe("OrgRag.indexRun", () => {
  // Fix #2: production needs to index ONE run's deliverables at completion (the postmortem hook),
  // not every run. indexRun scopes to a single runID.
  test("indexes only the given run's deliverables, not other runs'", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = enforcingStore()
    const result = await OrgRag.indexRun(tmp.path, stubEmbedder(), store, "run-eng")

    expect(result.indexed).toBeGreaterThan(0)
    expect(store.points.length).toBe(result.indexed)
    const runIDs = new Set(store.points.map((p) => p.payload["runID"]))
    expect(runIDs).toEqual(new Set(["run-eng"]))
    // Every accepted point also satisfies the real store's required-key set.
    for (const point of store.points) {
      for (const key of ISPAYLOADVALID_REQUIRED) expect(key in point.payload).toBe(true)
    }
  })

  test("is a no-op for a run with no deliverables", async () => {
    await using tmp = await tmpdir()
    const store = enforcingStore()
    const result = await OrgRag.indexRun(tmp.path, stubEmbedder(), store, "run-missing")
    expect(result.indexed).toBe(0)
    expect(store.points.length).toBe(0)
  })

  // Re-indexing the SAME run twice must not duplicate points against the real store's
  // delete-by-id-then-add upsert (deterministic per-chunk ids make re-index idempotent). The
  // enforcing store here mirrors that delete-by-id semantics so the invariant is actually exercised.
  test("re-indexing the same run is idempotent (stable ids, no duplicate points)", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const points: PointStruct[] = []
    const required = ISPAYLOADVALID_REQUIRED
    const idStore = {
      points,
      async upsertPoints(pts: PointStruct[]) {
        const valids = pts.filter((p) => !!p.payload && required.every((k) => k in p.payload))
        const ids = new Set(valids.map((p) => p.id))
        // Mirror LanceDBVectorStore.upsertPoints: delete existing ids first, then add.
        for (let i = points.length - 1; i >= 0; i--) if (ids.has(points[i]!.id)) points.splice(i, 1)
        points.push(...valids)
      },
      async search() {
        return [] as VectorStoreSearchResult[]
      },
    } as unknown as IVectorStore & { points: PointStruct[] }

    const first = await OrgRag.indexRun(tmp.path, stubEmbedder(), idStore, "run-eng")
    const afterFirst = idStore.points.length
    expect(afterFirst).toBe(first.indexed)
    await OrgRag.indexRun(tmp.path, stubEmbedder(), idStore, "run-eng")
    expect(idStore.points.length).toBe(afterFirst) // no duplication on re-index
  })
})

describe("OrgRag.search", () => {
  test("recovers run metadata from a managed organization path when the store drops custom payload fields", async () => {
    await using tmp = await tmpdir()
    const staged = await OrgWorkspace.stage(tmp.path, "Studio")
    const organization = await OrgWorkspace.publish(tmp.path, staged.entry.id)
    const store = memoryStore()
    await OrgWorkspace.run(organization, async () => {
      await seedDeliverable(tmp.path, "run-managed", "engineering", ENG_DOC)
      await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)
    })
    const fixedSchemaStore = {
      upsertPoints: store.upsertPoints,
      async search(vector: number[], prefix?: string, min?: number, max?: number) {
        const matches = await store.search(vector, prefix, min, max)
        return matches.map((match) => ({
          ...match,
          payload: Object.fromEntries(
            ISPAYLOADVALID_REQUIRED.map((key) => [key, match.payload?.[key]]),
          ),
        })) as VectorStoreSearchResult[]
      },
    } as IVectorStore

    const result = await OrgWorkspace.run(organization, () =>
      OrgRag.search(tmp.path, "Rust ledger SwiftUI", {}, stubEmbedder(), fixedSchemaStore),
    )

    expect(result.results[0]).toMatchObject({ runID: "run-managed", stage: "engineering" })
  })

  test("returns chunks with the right runID for a matching query", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    const { results, unavailable } = await OrgRag.search(
      tmp.path,
      "hash-chained ledger SwiftUI testing",
      {},
      stubEmbedder(),
      store,
    )

    expect(unavailable).toBeUndefined()
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.runID).toBe("run-eng")
    expect(results[0]!.stage).toBe("engineering")
    expect(typeof results[0]!.codeChunk).toBe("string")
    expect(typeof results[0]!.startLine).toBe("number")
  })

  test("a runID filter narrows results to that one run", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    const { results } = await OrgRag.search(tmp.path, "gate ledger testing", { runID: "run-eval" }, stubEmbedder(), store)

    expect(results.length).toBeGreaterThan(0)
    for (const hit of results) expect(hit.runID).toBe("run-eval")
  })

  test("a runID filter does not leak a same-prefix sibling run", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-1", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-10", "engineering", ENG_DOC)

    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    const { results } = await OrgRag.search(tmp.path, "gate ledger testing", { runID: "run-1" }, stubEmbedder(), store)

    for (const hit of results) expect(hit.runID).toBe("run-1")
  })

  test("a dept/stage filter narrows results to that stage", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    const { results } = await OrgRag.search(tmp.path, "gate ledger testing", { dept: "evaluation" }, stubEmbedder(), store)

    expect(results.length).toBeGreaterThan(0)
    for (const hit of results) expect(hit.stage).toBe("evaluation")
  })

  test("LOAD-BEARING: a null embedder returns unavailable and never throws", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)

    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    const outcome = await OrgRag.search(tmp.path, "anything", {}, undefined, store)

    expect(outcome.unavailable).toBe(true)
    expect(outcome.results).toEqual([])
    expect(typeof outcome.reason).toBe("string")
  })

  test("LOAD-BEARING: a throwing embedder (no key / unreachable) returns unavailable and never throws", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)

    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    const outcome = await OrgRag.search(tmp.path, "anything", {}, throwingEmbedder(), store)

    expect(outcome.unavailable).toBe(true)
    expect(outcome.results).toEqual([])
    expect(outcome.reason).toContain("no API key")
  })

  test("a missing store also degrades gracefully instead of throwing", async () => {
    await using tmp = await tmpdir()
    const outcome = await OrgRag.search(tmp.path, "anything", {}, stubEmbedder(), undefined)
    expect(outcome.unavailable).toBe(true)
    expect(outcome.results).toEqual([])
  })

  test("returns no results (not unavailable) when nothing is indexed yet", async () => {
    await using tmp = await tmpdir()
    const store = memoryStore()
    const outcome = await OrgRag.search(tmp.path, "anything", {}, stubEmbedder(), store)
    expect(outcome.unavailable).toBeUndefined()
    expect(outcome.results).toEqual([])
  })
})
