// kilocode_change - new file
// W6.2: tool-level integration coverage for the postmortem hook wired into tools.ts's four
// run-END choke points (OrgAdvanceTool done/halted, OrgDecisionTool no-go, OrgStopTool). Mirrors
// tools-fanout.test.ts's / stop-tool.test.ts's ManagedRuntime harness (the smallest seam that
// actually runs a real Tool.execute()), reusing wave4/wave5-exit.test.ts's writeDeliverable idiom
// to drive runs through OrgRunner-shaped state via the real tools. Also proves the load-bearing
// best-effort invariant: a FAILING lessons.md write must never change what org_advance/org_decision/
// org_stop return.
import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import type { EmbedderInfo, IEmbedder, IVectorStore, PointStruct, VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgAdvanceTool, OrgDecisionTool, OrgStopTool } from "../../../src/kilocode/organization/tools"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgPostmortem } from "../../../src/kilocode/organization/postmortem"
import { OrgMemory } from "../../../src/kilocode/organization/memory"
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

// plan -> review (gate:human, haltOn:no-go) -> marketing: the shortest path to a no-go halt.
const GATED = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    review: { chief: "review-chief", workers: ["security-validator"] },
    marketing: { chief: "mkt-chief", workers: ["copywriter"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "plan" }, { stage: "review", requires: ["plan"], gate: "human", haltOn: "no-go" }, { stage: "marketing", requires: ["review"] }],
})

const deps = { costOf: async () => 1 }

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
  params: { task_id?: string; task_results?: Array<{ stage: string; task_id: string }> } = {},
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

async function stopTool(runtime: ReturnType<typeof makeRuntime>, runID: string, reason: string) {
  const tool = await runtime.runPromise(OrgStopTool.pipe(Effect.flatMap((info) => info.init())))
  const out = await Effect.runPromise(tool.execute({ run_id: runID, reason }, ctx))
  return JSON.parse(out.output)
}

function lessonsFile(dir: string) {
  return path.join(dir, ".kilo", "org", "lessons.md")
}

// --- key-free stub embedder + in-memory store (same shape as org-search-tool.test.ts) so the
// completion-path org-RAG indexing (Fix #2) can be exercised with no key / no real LanceDB. ---
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
      throw new Error("embedder unreachable / no key")
    },
    async validateConfiguration() {
      return { valid: false, error: "no key" }
    },
    get embedderInfo(): EmbedderInfo {
      return { name: "openai" }
    },
  }
}
// In-memory store that ENFORCES the real store's isPayloadValid required-key set, so this test
// would catch a regression that reintroduced the missing-fileHash drop (Fix #1) on the hook path.
function enforcingStore(): IVectorStore & { points: PointStruct[] } {
  const points: PointStruct[] = []
  const required = ["filePath", "fileHash", "codeChunk", "startLine", "endLine"]
  return {
    points,
    async upsertPoints(pts: PointStruct[]) {
      points.push(...pts.filter((p) => !!p.payload && required.every((k) => k in p.payload)))
    },
    async search() {
      return [] as VectorStoreSearchResult[]
    },
  } as unknown as IVectorStore & { points: PointStruct[] }
}

describe("W6.2/W6.3 postmortem hook: best-effort org-RAG indexing at completion (Fix #2)", () => {
  test("a completed run indexes ITS deliverables when an embedder is configured", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "index on completion idea")
    const store = enforcingStore()
    // Inject a stub embedder+store: the hook resolves services via KiloIndexing.orgRagServices,
    // which the tool dynamically imports (same module singleton the spy patches).
    const services = spyOn(KiloIndexing, "orgRagServices").mockResolvedValue({ embedder: stubEmbedder(), store })
    const runtime = makeRuntime()
    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          await advanceTool(runtime, run.runID)
          await writeDeliverable(tmp.path, run.runID, "plan")
          await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
          await writeDeliverable(tmp.path, run.runID, "marketing")
          const done = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })
          expect(done.action).toBe("done")

          // The run's deliverables are now searchable: points were indexed for THIS run.
          expect(store.points.length).toBeGreaterThan(0)
          expect(new Set(store.points.map((p) => p.payload["runID"]))).toEqual(new Set([run.runID]))
        },
      })
    } finally {
      services.mockRestore()
    }
  })

  test("a completed run with NO embedder (orgRagServices -> undefined) still completes and indexes nothing", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "no embedder still completes idea")
    const services = spyOn(KiloIndexing, "orgRagServices").mockResolvedValue(undefined)
    const runtime = makeRuntime()
    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          await advanceTool(runtime, run.runID)
          await writeDeliverable(tmp.path, run.runID, "plan")
          await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
          await writeDeliverable(tmp.path, run.runID, "marketing")
          const done = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })
          expect(done.action).toBe("done")

          // Postmortem still landed (org-RAG being inert never blocks the rest of the hook).
          const text = await Bun.file(lessonsFile(tmp.path)).text()
          expect(text).toContain(run.runID)
          const state = await OrgState.read(tmp.path, run.runID)
          expect(state.status).toBe("completed")
        },
      })
    } finally {
      services.mockRestore()
    }
  })

  test("best-effort: a THROWING embedder on the completion path never changes the returned action", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "throwing embedder best effort idea")
    const services = spyOn(KiloIndexing, "orgRagServices").mockResolvedValue({
      embedder: throwingEmbedder(),
      store: enforcingStore(),
    })
    const runtime = makeRuntime()
    try {
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          await advanceTool(runtime, run.runID)
          await writeDeliverable(tmp.path, run.runID, "plan")
          await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
          await writeDeliverable(tmp.path, run.runID, "marketing")
          const done = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })

          expect(done.action).toBe("done")
          const state = await OrgState.read(tmp.path, run.runID)
          expect(state.status).toBe("completed")
          // The postmortem itself is unaffected by the embedder blowing up afterward.
          const text = await Bun.file(lessonsFile(tmp.path)).text()
          expect(text).toContain(run.runID)
        },
      })
    } finally {
      services.mockRestore()
    }
  })
})

describe("W6.2 postmortem hook: tool-level integration", () => {
  test("completed run (org_advance done): lessons.md gains the section and org memory recalls the lesson", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "postmortem exit idea")
    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const b1 = await advanceTool(runtime, run.runID)
        expect(b1.action).toBe("run_tasks")
        await writeDeliverable(tmp.path, run.runID, "plan")
        const b2 = await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
        expect(b2.action).toBe("run_tasks")
        await writeDeliverable(tmp.path, run.runID, "marketing")
        const b3 = await advanceTool(runtime, run.runID, { task_id: "ses_mkt" })
        expect(b3.action).toBe("done")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        expect(text).toContain(run.runID)
        expect(text).toContain("postmortem exit idea")
        expect(text).toContain("shipped")
        expect(text).toContain(`<!-- postmortem:${run.runID} -->`)

        const recalled = await OrgMemory.recall(tmp.path, { query: "postmortem exit idea" })
        expect(recalled.hits.some((h) => h.text.includes(run.runID) || h.text.includes("shipped"))).toBe(true)
      },
    })
  })

  test("no double-append: a second org_advance on the already-completed run does not duplicate the section", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "no double append idea")
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

        // Re-entrant call: the runner early-exits (status already "completed") and returns done again.
        const again = await advanceTool(runtime, run.runID)
        expect(again.action).toBe("done")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        const marker = `<!-- postmortem:${run.runID} -->`
        const occurrences = text.split(marker).length - 1
        expect(occurrences).toBe(1)
      },
    })
  })

  test("halted run (org_decision no-go): postmortem captures the failure and haltReason", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, GATED)
    const run = await OrgRunner.start(tmp.path, GATED, "no-go postmortem idea")
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

        const decided = await decisionTool(runtime, run.runID, "no-go", "hardcoded secret found")
        expect(decided.status).toBe("halted")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        expect(text).toContain(run.runID)
        expect(text).toContain("halted")
        expect(text).toContain("no-go")
        expect(text).toContain("hardcoded secret found")

        const state = await OrgState.read(tmp.path, run.runID)
        expect(text).toContain(state.haltReason!)

        const recalled = await OrgMemory.recall(tmp.path, { query: "no-go postmortem idea", dept: "review" })
        expect(recalled.hits.length).toBeGreaterThan(0)
      },
    })
  })

  test("halted run (org_stop): the postmortem is recorded at the emergency-stop choke point too", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "emergency stop idea")
    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await advanceTool(runtime, run.runID) // plan running

        const stopped = await stopTool(runtime, run.runID, "user asked to abort")
        expect(stopped.action).toBe("stopped")

        const text = await Bun.file(lessonsFile(tmp.path)).text()
        expect(text).toContain(run.runID)
        expect(text).toContain("emergency stop: user asked to abort")
      },
    })
  })

  // --- Best-effort proof (the load-bearing invariant): a FAILING lessons.md write must NEVER
  // change what org_advance/org_decision/org_stop return. Forced by pre-creating a DIRECTORY at
  // the exact lessons.md path, so OrgPostmortem.write's read (EISDIR, not ENOENT) genuinely
  // throws - a real failure, not a mock - while `.kilo/org/runs/...` (the run's own state) is
  // completely unaffected, so the run itself can still progress normally. ---
  describe("best-effort: a failing postmortem writer never changes the tool's returned action", () => {
    test("org_advance done", async () => {
      await using tmp = await tmpdir()
      await seedOrg(tmp.path, LINEAR)
      const run = await OrgRunner.start(tmp.path, LINEAR, "best effort done idea")
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

          // The action is exactly what it would be without the failing writer: unaffected.
          expect(done.action).toBe("done")
          expect(done.note).toContain("pipeline complete")

          // Proves the failure was REAL (not silently absorbed into a successful write): the
          // path is still a directory, no lessons.md file was ever produced.
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

    test("org_advance halted", async () => {
      await using tmp = await tmpdir()
      await seedOrg(tmp.path, LINEAR)
      const run = await OrgRunner.start(tmp.path, LINEAR, "best effort halted idea")
      await OrgState.update(tmp.path, run.runID, (s) => {
        s.status = "halted"
        s.haltReason = "stopped for best-effort test"
      })
      await mkdir(lessonsFile(tmp.path), { recursive: true })
      const runtime = makeRuntime()
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          const b = await advanceTool(runtime, run.runID)
          expect(b.action).toBe("halted")
          expect(b.reason).toBe("stopped for best-effort test")
        },
      })
    })

    test("org_decision no-go", async () => {
      await using tmp = await tmpdir()
      await seedOrg(tmp.path, GATED)
      const run = await OrgRunner.start(tmp.path, GATED, "best effort no-go idea")
      const runtime = makeRuntime()
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          await advanceTool(runtime, run.runID)
          await writeDeliverable(tmp.path, run.runID, "plan")
          await advanceTool(runtime, run.runID, { task_id: "ses_plan" })
          await writeDeliverable(tmp.path, run.runID, "review")
          await advanceTool(runtime, run.runID, { task_id: "ses_review" })

          await mkdir(lessonsFile(tmp.path), { recursive: true })
          const decided = await decisionTool(runtime, run.runID, "no-go", "best effort note")

          expect(decided.status).toBe("halted")
          expect(decided.next).toBe("call org_advance")
          const state = await OrgState.read(tmp.path, run.runID)
          expect(state.status).toBe("halted")
          expect(state.haltReason).toContain("best effort note")
        },
      })
    })

    test("org_stop", async () => {
      await using tmp = await tmpdir()
      await seedOrg(tmp.path, LINEAR)
      const run = await OrgRunner.start(tmp.path, LINEAR, "best effort stop idea")
      const runtime = makeRuntime()
      await provideTestInstance({
        directory: tmp.path,
        fn: async () => {
          await advanceTool(runtime, run.runID) // plan running
          await mkdir(lessonsFile(tmp.path), { recursive: true })

          const stopped = await stopTool(runtime, run.runID, "abort for best-effort test")
          expect(stopped.action).toBe("stopped")
          expect(stopped.reason).toBe("abort for best-effort test")

          const state = await OrgState.read(tmp.path, run.runID)
          expect(state.status).toBe("halted")
        },
      })
    })
  })

  test("OrgPostmortem.write's own idempotency check also covers a direct double-write of the same run outside the tool layer", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path, LINEAR)
    const run = await OrgRunner.start(tmp.path, LINEAR, "direct double write idea")
    const state = await OrgState.read(tmp.path, run.runID)
    const summary = OrgState.runSummary(state)
    await OrgPostmortem.write(tmp.path, state, summary, [])
    await OrgPostmortem.write(tmp.path, state, summary, [])
    const text = await Bun.file(lessonsFile(tmp.path)).text()
    expect(text.split(`<!-- postmortem:${run.runID} -->`).length - 1).toBe(1)
  })
})
