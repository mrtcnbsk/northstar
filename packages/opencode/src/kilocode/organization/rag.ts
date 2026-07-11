// kilocode_change - new file
import path from "path"
import { randomUUID } from "node:crypto"
import { readdir } from "node:fs/promises"
import type { IEmbedder, IVectorStore, PointStruct, VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { OrgState } from "./state"
import { OrgArtifacts } from "./artifacts"

/**
 * W6.3: org-scoped RAG over run deliverables (`.kilo/org/runs/*\/deliverables/*.md`).
 *
 * REUSE, not reimplementation: this is a thin layer over the SAME `IEmbedder`/`IVectorStore`
 * abstractions the kilo-indexing codebase engine already defines (`packages/kilo-indexing/src/
 * indexing/interfaces/{embedder,vector-store}.ts`). Nothing about embedding, vector search, or
 * scoring is reimplemented here - both dependencies are injected by the caller, exactly like
 * `CodeIndexSearchService` is injected in kilo-indexing's own tests (see
 * `packages/kilo-indexing/test/kilocode/indexing/search-service.test.ts`). That is what makes this
 * module testable with a hand-rolled stub embedder/store and zero API key (see
 * `test/kilocode/organization/org-rag.test.ts`), and what makes production wiring a matter of
 * resolving a real `IEmbedder`/`IVectorStore` pair (see `KiloIndexing`) rather than writing a
 * second engine.
 *
 * `Payload` (see vector-store.ts) is open-ended (`[key: string]: any`), so `runID`/`stage` ride
 * along in the point payload written at index time. That round-trips cleanly through a store that
 * preserves arbitrary payload keys (e.g. this module's own tests' in-memory mock, matching the
 * `IVectorStore` contract). The PRODUCTION `LanceDBVectorStore`, however, has a fixed table schema
 * and reconstructs only `{filePath, fileHash, codeChunk, startLine, endLine}` on `search()` - any
 * extra payload key (including `runID`/`stage`) is silently dropped on the way back out. To stay
 * correct against BOTH kinds of store, `search()` below derives `runID`/`stage` primarily by
 * parsing them out of `filePath` (which the deliverable path format
 * `.kilo/org/runs/<runID>/deliverables/<stage>.md` encodes unambiguously, and which every
 * `IVectorStore` implementation - real or stub - always preserves), falling back to the raw
 * payload fields only if that parse fails (e.g. a non-standard store/path shape in a test).
 *
 * Namespacing/isolation: search is scoped with `directoryPrefix` (mirroring how
 * `CodeIndexSearchService`/`LanceDBVectorStore` already scope codebase search to a subdirectory,
 * see `directoryPrefix` in vector-store.ts) to `.kilo/org/runs/<runID>/` when a `runID` is given,
 * else the org runs root `.kilo/org/runs/` - so a shared collection can never leak a query outside
 * org deliverables, and a `runID` prefix can never accidentally match a same-prefixed sibling run
 * (e.g. "run-1" vs "run-10") because the prefix always carries its own trailing path separator.
 */
export namespace OrgRag {
  export type Chunk = { text: string; startLine: number; endLine: number }

  export type SearchHit = {
    filePath: string
    runID: string
    stage: string
    startLine: number
    endLine: number
    score: number
    codeChunk: string
  }

  export type SearchOptions = { runID?: string; dept?: string; limit?: number }

  export type SearchResult = { results: SearchHit[]; unavailable?: boolean; reason?: string }

  /**
   * Simple paragraph chunker: splits markdown on blank-line boundaries, tracking 1-based
   * (startLine, endLine) ranges for each non-blank chunk. Deliberately NOT AST/semantic-aware -
   * deliverables are prose markdown produced by chiefs, not source code, so kilo-indexing's
   * tree-sitter code parser is the wrong tool here; a paragraph split is sufficient and keeps this
   * module free of a second chunking engine to maintain.
   */
  export function chunk(content: string): Chunk[] {
    const lines = content.split("\n")
    const chunks: Chunk[] = []
    let buffer: string[] = []
    let start = 0

    const flush = (endIdx: number) => {
      if (buffer.length === 0) return
      const text = buffer.join("\n").trim()
      if (text.length > 0) chunks.push({ text, startLine: start + 1, endLine: endIdx + 1 })
      buffer = []
    }

    lines.forEach((line, idx) => {
      if (line.trim() === "") {
        flush(idx - 1)
        start = idx + 1
        return
      }
      if (buffer.length === 0) start = idx
      buffer.push(line)
    })
    flush(lines.length - 1)
    return chunks
  }

  async function deliverableFiles(dirPath: string) {
    return readdir(dirPath, { withFileTypes: true }).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return []
      throw e
    })
  }

  /**
   * Enumerates every run's deliverables via `OrgState.list` + `OrgArtifacts`, chunks each file,
   * embeds the chunks, and upserts them into `store`. Safe to call repeatedly (re-indexing) - it
   * does not attempt incremental/dedup tracking (no `CacheManager` reuse); callers that need that
   * can layer it on top, matching the plan's "do not over-engineer" guidance for W6.3.
   */
  export async function indexDeliverables(
    projectDir: string,
    embedder: IEmbedder,
    store: IVectorStore,
  ): Promise<{ indexed: number; runs: number }> {
    const runIDs = await OrgState.list(projectDir)
    let indexed = 0
    for (const runID of runIDs) {
      const dir = OrgArtifacts.deliverablesDir(projectDir, runID)
      const entries = await deliverableFiles(dir)
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      for (const entry of files) {
        const stage = entry.name.slice(0, -3)
        const filePath = OrgArtifacts.deliverablePath(projectDir, runID, stage)
        const text = await Bun.file(filePath).text()
        const chunks = chunk(text)
        if (chunks.length === 0) continue

        const embedded = await embedder.createEmbeddings(chunks.map((c) => c.text))
        const points: PointStruct[] = chunks.map((c, i) => ({
          id: randomUUID(),
          vector: embedded.embeddings[i] ?? [],
          payload: {
            filePath,
            codeChunk: c.text,
            startLine: c.startLine,
            endLine: c.endLine,
            runID,
            stage,
          },
        }))
        await store.upsertPoints(points)
        indexed += points.length
      }
    }
    return { indexed, runs: runIDs.length }
  }

  const DELIVERABLE_PATH_RE = /\/\.kilo\/org\/runs\/([^/]+)\/deliverables\/([^/]+)\.md$/

  /** Recover {runID, stage} primarily from `filePath` (survives a fixed-schema store); falls back
   * to raw payload fields for a store/test that doesn't shape paths this way. */
  function parseDeliverable(payload: Record<string, unknown> | null | undefined): { runID: string; stage: string } | undefined {
    const filePath = typeof payload?.["filePath"] === "string" ? (payload["filePath"] as string).replaceAll("\\", "/") : undefined
    const match = filePath?.match(DELIVERABLE_PATH_RE)
    if (match) return { runID: match[1]!, stage: match[2]! }
    const runID = payload?.["runID"]
    const stage = payload?.["stage"]
    if (typeof runID === "string" && typeof stage === "string") return { runID, stage }
    return undefined
  }

  /**
   * Embeds `query` and searches `store`, scoped by `opts.runID`/`opts.dept` (dept narrows to a
   * deliverable `stage`, since a run's stage names ARE its department names by convention - see
   * `OrgSchema`'s `departments`/`pipeline` shape). GRACEFUL DEGRADATION is load-bearing: a missing
   * `embedder`/`store`, or any failure embedding the query or reading the store (no API key,
   * unreachable endpoint, etc.), is caught here and converted into `{results: [], unavailable:
   * true, reason}` - this function must NEVER throw, mirroring `KiloIndexing.search`'s own
   * not-configured handling (`packages/opencode/src/kilocode/indexing.ts`, which returns `[]`
   * rather than throwing when indexing isn't ready).
   */
  export async function search(
    projectDir: string,
    query: string,
    opts: SearchOptions = {},
    embedder?: IEmbedder,
    store?: IVectorStore,
  ): Promise<SearchResult> {
    try {
      if (!embedder || !store) {
        return { results: [], unavailable: true, reason: "no embedder configured" }
      }

      const embedded = await embedder.createEmbeddings([query])
      const vector = embedded?.embeddings?.[0]
      if (!vector) {
        return { results: [], unavailable: true, reason: "embedder returned no vector for the query" }
      }

      const runsRoot = OrgState.runsDir(projectDir)
      const scope = opts.runID ? path.join(runsRoot, opts.runID) : runsRoot
      const directoryPrefix = `${scope}${path.sep}`

      // When narrowing by dept/stage, over-fetch (no store-side limit) so the post-filter below
      // doesn't starve the result set below opts.limit; the final slice enforces the real limit.
      const storeLimit = opts.dept ? undefined : opts.limit
      const matches: VectorStoreSearchResult[] = await store.search(vector, directoryPrefix, undefined, storeLimit)

      const results: SearchHit[] = matches.flatMap((match) => {
        const payload = match.payload
        const parsed = parseDeliverable(payload)
        if (!parsed) return []
        if (opts.dept && parsed.stage !== opts.dept) return []
        if (
          typeof payload?.filePath !== "string" ||
          typeof payload?.codeChunk !== "string" ||
          typeof payload?.startLine !== "number" ||
          typeof payload?.endLine !== "number"
        ) {
          return []
        }

        return [
          {
            filePath: payload.filePath,
            runID: parsed.runID,
            stage: parsed.stage,
            startLine: payload.startLine,
            endLine: payload.endLine,
            score: match.score,
            codeChunk: payload.codeChunk,
          },
        ]
      })

      const limited = typeof opts.limit === "number" ? results.slice(0, opts.limit) : results
      return { results: limited }
    } catch (err) {
      return {
        results: [],
        unavailable: true,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}
