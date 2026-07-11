// kilocode_change - new file
// W6.3: tool-level coverage for org_search. Mirrors org-memory-tools.test.ts's ManagedRuntime
// harness (the smallest seam that runs a real Tool.execute()). KiloIndexing.orgRagServices is
// spied to inject a stub embedder/store (no key) or `undefined` (no embedder configured), so this
// suite never touches a real vector store or network.
import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import type { EmbedderInfo, IEmbedder, IVectorStore, PointStruct, VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgSearchTool } from "../../../src/kilocode/tool/org-search"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { KiloIndexing } from "../../../src/kilocode/indexing"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Plugin } from "../../../src/plugin"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: { eng: { chief: "chief", workers: ["worker"] } },
  pipeline: [{ stage: "eng" }],
})

function makeRuntime() {
  return ManagedRuntime.make(
    Layer.mergeAll(
      CrossSpawnSpawner.defaultLayer,
      AppFileSystem.defaultLayer,
      Plugin.defaultLayer,
      Truncate.defaultLayer,
      Agent.defaultLayer,
      Config.defaultLayer,
      RuntimeFlags.layer(),
    ),
  )
}

function ctxFor(agent: string) {
  return {
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make("msg_test"),
    callID: "",
    agent,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

async function seedOrg(dir: string) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(ORG))
}

async function seedDeliverable(projectDir: string, runID: string, stage: string, text: string) {
  const file = OrgArtifacts.deliverablePath(projectDir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, text)
}

// Same deterministic, key-free stub embedder as org-rag.test.ts.
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
function stubEmbedder(): IEmbedder {
  return {
    async createEmbeddings(texts) {
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

describe("org_search tool", () => {
  test("is registered under the org_ id prefix (visibility + primary-mode gates apply)", async () => {
    const runtime = makeRuntime()
    const info = await runtime.runPromise(OrgSearchTool)
    expect(info.id).toBe("org_search")
    expect(info.id.startsWith("org_")).toBe(true)
  })

  test("rejects a non-CEO agent", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgSearchTool.pipe(Effect.flatMap((info) => info.init())))
        const exit = await Effect.runPromiseExit(tool.execute({ query: "anything" }, ctxFor("worker")))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Cause.squash(exit.cause)
        expect((error as Error).message).toContain('org tools are reserved for the CEO agent "ceo"')
      },
    })
  })

  test("LOAD-BEARING: degrades gracefully (not an error) when no embedder is configured", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)
    await seedDeliverable(tmp.path, "run-1", "eng", "some deliverable content that is long enough to matter here")

    const runtime = makeRuntime()
    const services = spyOn(KiloIndexing, "orgRagServices").mockResolvedValue(undefined)

    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          const tool = await runtime.runPromise(OrgSearchTool.pipe(Effect.flatMap((info) => info.init())))
          const out = await Effect.runPromise(tool.execute({ query: "anything" }, ctxFor("ceo")))
          expect(out.output).toContain("org search unavailable")
          expect(out.output).toContain("configure an embedder")
        },
      })
    } finally {
      services.mockRestore()
    }
  })

  test("returns cited results when an embedder/store is available", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)
    await seedDeliverable(
      tmp.path,
      "run-1",
      "eng",
      "The Rust hash-chained ledger stores transactions locally with SwiftUI as the front end.",
    )

    const store = memoryStore()
    const embedder = stubEmbedder()
    const runtime = makeRuntime()
    const services = spyOn(KiloIndexing, "orgRagServices").mockResolvedValue({ embedder, store })

    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          const { OrgRag } = await import("../../../src/kilocode/organization/rag")
          await OrgRag.indexDeliverables(tmp.path, embedder, store)

          const tool = await runtime.runPromise(OrgSearchTool.pipe(Effect.flatMap((info) => info.init())))
          const out = await Effect.runPromise(tool.execute({ query: "hash-chained ledger SwiftUI" }, ctxFor("ceo")))

          expect(out.output).toContain("cite:")
          expect(out.output).toContain("(run run-1)")
          expect(out.metadata.results.length).toBeGreaterThan(0)
          expect(out.metadata.results[0]?.runID).toBe("run-1")
        },
      })
    } finally {
      services.mockRestore()
    }
  })

  test("returns a clean no-results message (not an error) when nothing matches", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)

    const store = memoryStore()
    const embedder = stubEmbedder()
    const runtime = makeRuntime()
    const services = spyOn(KiloIndexing, "orgRagServices").mockResolvedValue({ embedder, store })

    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          const tool = await runtime.runPromise(OrgSearchTool.pipe(Effect.flatMap((info) => info.init())))
          const out = await Effect.runPromise(tool.execute({ query: "nothing indexed yet" }, ctxFor("ceo")))
          expect(out.output).not.toContain("unavailable")
          expect(out.metadata.results).toEqual([])
        },
      })
    } finally {
      services.mockRestore()
    }
  })
})
