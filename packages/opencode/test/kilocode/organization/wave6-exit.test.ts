// kilocode_change - new file
// Wave 6 exit criteria made executable: postmortem lessons capture, org memory recall, org-RAG
// namespace + citations, graceful no-embedder degradation, best-effort completion.
//
// Wave 6 gave an org the ability to LEARN across runs (W6.1-W6.3): every completed/halted run gets
// a deterministic postmortem appended to `.kilo/org/lessons.md` and mirrored into a lexical-recall
// org memory pool, and a run's shipped deliverables become searchable (with citations) by a later
// run via org-scoped RAG over a stub/injected embedder+store - no LLM narration, no embedder API
// key required anywhere in this file. This mirrors wave4-exit.test.ts/wave5-exit.test.ts's shape
// (one file, one exit criterion per `test`) while reusing three existing harnesses verbatim rather
// than inventing new infra:
//   - postmortem-integration.test.ts's ManagedRuntime + real Tool.execute() harness (the only path
//     that actually calls the private `recordPostmortem` recorder wired into tools.ts's run-END
//     choke points), for criteria 1, 2, 5.
//   - org-rag.test.ts's deterministic feature-hash stub embedder + in-memory mock IVectorStore
//     (no API key, no real LanceDB), for criteria 3, 4.
//   - semantic-search.test.ts's KiloIndexing.search spy, for the `cite:` token half of criterion 4
//     (the same output-formatting convention org_search.ts reuses for org-RAG citations).
import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import type {
  EmbedderInfo,
  IEmbedder,
  IVectorStore,
  PointStruct,
  VectorStoreSearchResult,
} from "@kilocode/kilo-indexing/engine"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgAdvanceTool, OrgDecisionTool } from "../../../src/kilocode/organization/tools"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgMemory } from "../../../src/kilocode/organization/memory"
import { OrgRag } from "../../../src/kilocode/organization/rag"
import { SemanticSearchTool } from "../../../src/kilocode/tool/semantic-search"
import { KiloIndexing } from "../../../src/kilocode/indexing"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Plugin } from "../../../src/plugin"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { SessionRunState } from "../../../src/session/run-state"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

// --- shared org-tool harness (criteria 1, 2, 5) -------------------------------------------------
// Verbatim shape of postmortem-integration.test.ts's harness: the ManagedRuntime + real
// Tool.execute() seam is the ONLY path that reaches tools.ts's private `recordPostmortem`
// recorder, so re-creating it here (rather than driving OrgRunner.advance directly, which never
// touches lessons.md/org memory) is required, not a stylistic choice.

// OrgAdvanceTool's init yields Session.Service (for its isResumable closure). None of these tests
// pass a resumable resumeTaskID, so `.get` is never expected to be hit.
const sessionStub = Session.Service.of({
  list: () => Effect.die("unused in test"),
  create: () => Effect.die("unused in test"),
  fork: () => Effect.die("unused in test"),
  touch: () => Effect.die("unused in test"),
  get: () => Effect.die("unused in test: no resumable resumeTaskID on this path"),
  setTitle: () => Effect.die("unused in test"),
  setArchived: () => Effect.die("unused in test"),
  setMetadata: () => Effect.die("unused in test"),
  setPermission: () => Effect.die("unused in test"),
  setRevert: () => Effect.die("unused in test"),
  clearRevert: () => Effect.die("unused in test"),
  setSummary: () => Effect.die("unused in test"),
  diff: () => Effect.die("unused in test"),
  messages: () => Effect.die("unused in test"),
  children: () => Effect.die("unused in test"),
  remove: () => Effect.die("unused in test"),
  updateMessage: () => Effect.die("unused in test"),
  removeMessage: () => Effect.die("unused in test"),
  removePart: () => Effect.die("unused in test"),
  getPart: () => Effect.die("unused in test"),
  updatePart: () => Effect.die("unused in test"),
  updatePartDelta: () => Effect.die("unused in test"),
  findMessage: () => Effect.die("unused in test"),
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
      Layer.succeed(Session.Service, sessionStub),
      Layer.succeed(
        SessionRunState.Service,
        SessionRunState.Service.of({
          assertNotBusy: () => Effect.void,
          cancel: () => Effect.void,
          ensureRunning: () => Effect.die("unused in test"),
          startShell: () => Effect.die("unused in test"),
        }),
      ),
    ),
  )
}

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "ceo",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

// plan -> marketing, no gates: the shortest path to a `done` batch.
const LINEAR = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    marketing: { chief: "mkt-chief", workers: ["copywriter"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "plan" }, { stage: "marketing", requires: ["plan"] }],
})

// plan -> review (gate:human, haltOn:no-go) -> marketing: exercises both an approve (ships,
// decisions captured) and a no-go (halts, failure captured) postmortem.
const GATED = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    review: { chief: "review-chief", workers: ["security-validator"] },
    marketing: { chief: "mkt-chief", workers: ["copywriter"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "plan" },
    { stage: "review", requires: ["plan"], gate: "human", haltOn: "no-go" },
    { stage: "marketing", requires: ["review"] },
  ],
})

async function writeDeliverable(dir: string, runID: string, stage: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

async function seedOrg(dir: string, org: OrgSchema.Organization) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(org))
}

async function advanceTool(
  runtime: ReturnType<typeof makeRuntime>,
  runID: string,
  params: { task_id?: string } = {},
) {
  const tool = await runtime.runPromise(OrgAdvanceTool.pipe(Effect.flatMap((info) => info.init())))
  const out = await Effect.runPromise(tool.execute({ run_id: runID, ...params }, ctx))
  return JSON.parse(out.output)
}

async function decisionTool(
  runtime: ReturnType<typeof makeRuntime>,
  runID: string,
  decision: "approve" | "no-go" | "revise",
  note?: string,
) {
  const tool = await runtime.runPromise(OrgDecisionTool.pipe(Effect.flatMap((info) => info.init())))
  const out = await Effect.runPromise(tool.execute({ run_id: runID, decision, note }, ctx))
  return JSON.parse(out.output)
}

function lessonsFile(dir: string) {
  return path.join(dir, ".kilo", "org", "lessons.md")
}

// --- shared org-RAG harness (criteria 3, 4) ------------------------------------------------------
// Verbatim deterministic, key-free stub embedder + in-memory mock IVectorStore from org-rag.test.ts:
// feature-hashes tokens into a small fixed-width vector so cosine similarity reflects shared
// vocabulary, without any real embedding model or API key.
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

describe("Wave 6 exit verification", () => {
  // --- 1. Postmortem -> lessons.md + org memory (completed run). --------------------------------
  // Drives a GATED run all the way through an APPROVE gate to `done`, so the postmortem section
  // has to capture BOTH per-stage costs and a gate DECISION, not just a linear happy path.
  test("postmortem on a completed run: lessons.md gains per-stage costs/decisions + total + 'shipped', and org memory recalls it", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, GATED)
    const run = await OrgRunner.start(tmp.path, GATED, "wave6 ledger sync completed idea")
    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const b1 = await advanceTool(runtime, run.runID)
        expect(b1.action).toBe("run_tasks")
        await writeDeliverable(tmp.path, run.runID, "plan")

        const b2 = await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
        expect(b2.action).toBe("run_tasks") // review instructed
        await writeDeliverable(tmp.path, run.runID, "review")

        const gated = await advanceTool(runtime, run.runID, { task_id: "ses_review" })
        expect(gated.action).toBe("human_gate")

        const decided = await decisionTool(runtime, run.runID, "approve")
        expect(decided.status).not.toBe("halted")

        const b3 = await advanceTool(runtime, run.runID)
        expect(b3.action).toBe("run_tasks") // marketing instructed
        await writeDeliverable(tmp.path, run.runID, "marketing")

        const done = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })
        expect(done.action).toBe("done")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        expect(text).toContain(`<!-- postmortem:${run.runID} -->`)
        expect(text).toContain(run.runID)
        expect(text).toContain("wave6 ledger sync completed idea")
        expect(text).toContain("outcome: shipped")

        // per-stage costs: every stage row carries a `$<cost>` column (deps.costOf is stubbed via
        // sessionStub.messages dying -> cost degrades to 0, but the column itself is what W6.2
        // promises to capture; the "no cost tracking crashes the postmortem" half is the point).
        expect(text).toMatch(/\| plan \| completed \| \$\d+(\.\d+)? \| \d+ \| - \|/)
        // per-stage decisions: the review row records the human's "approve" decision.
        expect(text).toMatch(/\| review \| completed \| \$\d+(\.\d+)? \| \d+ \| approve \|/)
        // total cost line.
        expect(text).toContain("- total cost: $")
        // gate-decision trail (from OrgAudit) also lands in the section.
        expect(text).toContain("Gate decisions:")
        expect(text).toContain("review: approve")

        const recalled = await OrgMemory.recall(tmp.path, { query: "ledger sync completed idea" })
        expect(recalled.hits.some((h) => h.text.includes(run.runID) || h.text.includes("shipped"))).toBe(true)
      },
    })
  })

  // --- 2. Postmortem captures failure (halted run). ----------------------------------------------
  test("postmortem on a halted run: lessons.md records the failure + haltReason, and org memory recalls it", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, GATED)
    const run = await OrgRunner.start(tmp.path, GATED, "wave6 ledger migration halted idea")
    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await advanceTool(runtime, run.runID) // plan
        await writeDeliverable(tmp.path, run.runID, "plan")
        await advanceTool(runtime, run.runID, { task_id: "ses_plan" }) // review
        await writeDeliverable(tmp.path, run.runID, "review")
        const gated = await advanceTool(runtime, run.runID, { task_id: "ses_review" })
        expect(gated.action).toBe("human_gate")

        const decided = await decisionTool(runtime, run.runID, "no-go", "critical regression in ledger migration")
        expect(decided.status).toBe("halted")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        expect(text).toContain(run.runID)
        expect(text).toContain("status: halted")
        expect(text).toContain("no-go")
        expect(text).toContain("critical regression in ledger migration")

        const state = await OrgState.read(tmp.path, run.runID)
        expect(state.haltReason).toBeDefined()
        expect(text).toContain(state.haltReason!)

        // failed/no-go'd stage ("review") is the dept tag OrgPostmortem.keyStage assigns.
        const recalled = await OrgMemory.recall(tmp.path, { query: "ledger migration halted idea", dept: "review" })
        expect(recalled.hits.length).toBeGreaterThan(0)
        expect(recalled.hits.some((h) => h.text.includes(run.runID))).toBe(true)
      },
    })
  })

  // --- 3. Org-RAG over 2 runs' deliverables (stub embedder, no key). -----------------------------
  test("org-RAG indexes 2 runs' deliverables and search resolves the correct source run, narrowable by runID", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    await seedDeliverable(tmp.path, "run-eng", "engineering", ENG_DOC)

    const store = memoryStore()
    const indexed = await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)
    expect(indexed.runs).toBe(2)
    expect(indexed.indexed).toBeGreaterThan(0)

    // Unscoped search resolves to the correct source run for a query matching one doc's vocabulary.
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

    // A {runID} filter narrows the same query to exactly that one run.
    const narrowed = await OrgRag.search(
      tmp.path,
      "gate ledger testing",
      { runID: "run-eval" },
      stubEmbedder(),
      store,
    )
    expect(narrowed.results.length).toBeGreaterThan(0)
    for (const hit of narrowed.results) expect(hit.runID).toBe("run-eval")
  })

  // --- 4. Citations + graceful no-key degradation. -------------------------------------------------
  test("OrgRag.search degrades to {unavailable:true} without throwing on a missing/throwing embedder; results carry cite-able file:line", async () => {
    await using tmp = await tmpdir()
    await seedDeliverable(tmp.path, "run-eval", "evaluation", EVAL_DOC)
    const store = memoryStore()
    await OrgRag.indexDeliverables(tmp.path, stubEmbedder(), store)

    // No embedder at all (undefined): never throws.
    const noEmbedder = await OrgRag.search(tmp.path, "anything", {}, undefined, store)
    expect(noEmbedder.unavailable).toBe(true)
    expect(noEmbedder.results).toEqual([])
    expect(typeof noEmbedder.reason).toBe("string")

    // A throwing embedder (no API key / unreachable): never throws.
    const noKey = await OrgRag.search(tmp.path, "anything", {}, throwingEmbedder(), store)
    expect(noKey.unavailable).toBe(true)
    expect(noKey.results).toEqual([])
    expect(noKey.reason).toContain("no API key")

    // A real match carries the (filePath, startLine) pair a citation is built from.
    const { results } = await OrgRag.search(tmp.path, "feasibility gate offline-first", {}, stubEmbedder(), store)
    expect(results.length).toBeGreaterThan(0)
    expect(typeof results[0]!.filePath).toBe("string")
    expect(typeof results[0]!.startLine).toBe("number")

    // The citation FORMATTER itself: org_search.ts reuses the exact `cite: <file>:<line>` token
    // convention semantic_search.ts introduced (W6.3's own comment: "same output-formatting
    // convention" - see semantic-search.ts). Proven here by reusing semantic-search.test.ts's own
    // spy-on-KiloIndexing.search approach, so this file doesn't need to duplicate org-search-tool
    // .test.ts's separate ManagedRuntime/CEO-guard harness just to see the same string shape.
    await using workspace = await tmpdir({ git: true })
    await provideTestInstance({
      directory: workspace.path,
      fn: async () => {
        const rt = ManagedRuntime.make(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))
        const search = spyOn(KiloIndexing, "search").mockResolvedValue([
          {
            id: "1",
            score: 0.9,
            payload: {
              filePath: "src/a.ts",
              codeChunk: "export const a = 1",
              startLine: 5,
              endLine: 9,
            },
          },
        ] as never)
        try {
          const tool = await rt.runPromise(SemanticSearchTool.pipe(Effect.flatMap((info) => info.init())))
          const baseCtx = {
            sessionID: SessionID.make("ses_test-cite"),
            messageID: MessageID.make("msg_test-cite"),
            callID: "",
            agent: "code",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          }
          const result = await rt.runPromise(tool.execute({ query: "citation check" }, baseCtx))
          expect(result.output).toContain("cite: src/a.ts:5")
        } finally {
          search.mockRestore()
        }
      },
    })
  })

  // --- 5. Best-effort invariants: a failing postmortem writer never changes the run's outcome,
  // and the postmortem fires exactly ONCE even on a re-entrant advance. ----------------------------
  test("best-effort: a failing lessons.md write never changes done/halted", async () => {
    // Pre-create a DIRECTORY at the exact lessons.md path, so OrgPostmortem.write's read
    // (EISDIR, not ENOENT) genuinely throws - a real failure, not a mock - while the run's own
    // state.json is completely unaffected, proving the run still completes normally.
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "wave6 best effort idea")
    await mkdir(lessonsFile(tmp.path), { recursive: true }) // lessons.md path is a DIRECTORY: writes fail
    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await advanceTool(runtime, run.runID)
        await writeDeliverable(tmp.path, run.runID, "plan")
        await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
        await writeDeliverable(tmp.path, run.runID, "marketing")
        const done = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })

        // The tool's returned action is exactly what it would be without the failing writer.
        expect(done.action).toBe("done")
        expect(done.note).toContain("pipeline complete")

        // Proves the failure was REAL (not silently absorbed): the path is still a directory.
        const stillDir = await Bun.file(lessonsFile(tmp.path))
          .text()
          .then(() => false)
          .catch((e: NodeJS.ErrnoException) => e.code === "EISDIR")
        expect(stillDir).toBe(true)

        const state = await OrgState.read(tmp.path, run.runID)
        expect(state.status).toBe("completed")
      },
    })
  })

  test("postmortem section never double-appends after a completed run", async () => {
    // A re-entrant org_advance on an already-completed run (the runner's
    // early-exit still returns `done`) must not duplicate the run's postmortem section.
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "wave6 fire once idea")
    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await advanceTool(runtime, run.runID)
        await writeDeliverable(tmp.path, run.runID, "plan")
        await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
        await writeDeliverable(tmp.path, run.runID, "marketing")
        const done = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })
        expect(done.action).toBe("done")

        // Re-entrant call: same run_id, no new task_id.
        const again = await advanceTool(runtime, run.runID)
        expect(again.action).toBe("done")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        const marker = `<!-- postmortem:${run.runID} -->`
        expect(text.split(marker).length - 1).toBe(1)
      },
    })
  })
})
