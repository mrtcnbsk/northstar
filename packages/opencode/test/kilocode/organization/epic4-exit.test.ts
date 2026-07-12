// kilocode_change - new file
/**
 * EPIC 4 (generalize) EXIT TEST.
 *
 * Exit criterion: the org kernel (schema/state/runner/tools) is generic - a non-iOS organization
 * (research-desk) can be scaffolded, driven to completion, and the Apple-only tool surface stays
 * opt-in via toolpacks rather than baked into the kernel.
 *
 * Three load-bearing proofs, each driving a REAL wired component rather than re-deriving expected
 * values from the same code under test:
 *
 *  1. research-desk (a genuine non-iOS template org) runs plan(gate:approve) -> research ->
 *     synthesize -> review -> completed through the deterministic fixture harness (OrgBenchmark),
 *     which drives the REAL OrgRunner/OrgState (no reimplemented pipeline logic). A kernel that
 *     silently still assumed an iOS-shaped pipeline (e.g. hardcoded stage names, an Apple-only
 *     gate path) would fail to reach "completed" here.
 *
 *  2. The apple-delivery toolpack actually gates tool VISIBILITY through the real registry
 *     pipeline (ToolRegistry.tools -> KiloToolRegistry.applyVisibility): a project scaffolded from
 *     research-desk's organization.jsonc (toolpacks: []) hides every Apple tool id, while the SAME
 *     probe against ios-app-factory's organization.jsonc (toolpacks: ["apple-delivery"]) shows all
 *     of them - proving the Apple surface is opt-in, not load-bearing for a generic org to work.
 *
 *  3. `org init --template research-desk` (via handleInit, the exact function the CLI's `org init`
 *     command calls) scaffolds a valid `.kilo/` in a fresh tmpdir cwd - loadOrganization +
 *     validate + crossCheck all come back clean against the scaffolded copy, proving the
 *     generalized template is genuinely usable end to end, not just valid in the repo's own copy.
 */
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { parse as parseJsonc } from "jsonc-parser"
import { Effect, Layer } from "effect"
import { Agent } from "../../../src/agent/agent"
import { ToolRegistry } from "../../../src/tool/registry"
import { TOOLPACKS } from "../../../src/kilocode/tool/toolpacks"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgBenchmark } from "../../../src/kilocode/organization/benchmark"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgTemplates, handleInit } from "../../../src/kilocode/cli/cmd/org"
import * as ConfigAgent from "../../../src/config/agent"
import { disposeAllInstances, provideTmpdirInstance, tmpdir } from "../../fixture/fixture"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../../lib/effect"

const TEMPLATES_DIR = path.resolve(import.meta.dir, "../../../../..", "templates")

async function loadTemplateOrg(name: string): Promise<OrgSchema.Organization> {
  const text = await Bun.file(path.join(TEMPLATES_DIR, name, "organization.jsonc")).text()
  return OrgSchema.parse(parseJsonc(text))
}

afterEach(async () => {
  await disposeAllInstances()
})

// -------------------------------------------------------------------------------------------
// 1. research-desk (non-iOS org) drives to `completed` via the deterministic fixture harness.
// -------------------------------------------------------------------------------------------

describe("EPIC 4 exit: research-desk (non-iOS org) runs to completed via the deterministic fixture runner", () => {
  test("plan(gate:approve) -> research -> synthesize -> review -> completed, all deliverables produced", async () => {
    await using tmp = await tmpdir()
    const org = await loadTemplateOrg("research-desk")
    // Sanity: this is the REAL template, not a hand-built stub - and it carries no Apple toolpack.
    expect(OrgSchema.validate(org)).toEqual([])
    expect(org.toolpacks).toEqual([])

    const bench = OrgBenchmark.parse({
      org,
      idea: "EPIC 4 exit: research the on-device agent-engine market",
      costs: { plan: 1, research: 4, synthesize: 3, review: 1 },
      decisions: { plan: "approve" },
      sla: { expectStatus: "completed", deliverables: ["plan", "research", "synthesize", "review"] },
    })
    expect(OrgBenchmark.validate(bench)).toEqual([])

    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)

    // LOAD-BEARING: a REAL run through OrgRunner (not a re-derivation of expected values) actually
    // reaches "completed" and produced every stage's deliverable, including past the human gate.
    expect(result.status).toBe("completed")
    expect(result.deliverablesProduced.sort()).toEqual(["plan", "research", "review", "synthesize"])
    expect(result.slaViolations).toEqual([])

    // Cross-check against the REAL persisted state.json (not just the harness's own summary).
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.status).toBe("completed")
    expect(state.stages["plan"]!.status).toBe("completed")
    expect(state.stages["research"]!.status).toBe("completed")
    expect(state.stages["synthesize"]!.status).toBe("completed")
    expect(state.stages["review"]!.status).toBe("completed")
    // The single editable plan gate genuinely fired and was answered - not skipped or auto-completed.
    expect(state.stages["plan"]!.decision).toBe("approve")
    expect(state.stages["review"]!.decision).toBeUndefined()
  })

  test("a scripted no-go at the plan gate halts the run instead of completing (the gate is real, not decorative)", async () => {
    await using tmp = await tmpdir()
    const org = await loadTemplateOrg("research-desk")

    const bench = OrgBenchmark.parse({
      org,
      idea: "EPIC 4 exit: a report that fails quality review",
      costs: { plan: 1, research: 1, synthesize: 1, review: 1 },
      decisions: { plan: "no-go" },
      sla: { expectStatus: "halted" },
    })
    const result = await OrgBenchmark.runBenchmark(tmp.path, bench)

    expect(result.status).toBe("halted")
    expect(result.slaViolations).toEqual([])
    const state = await OrgState.read(tmp.path, result.runID)
    expect(state.status).toBe("halted")
  })
})

// -------------------------------------------------------------------------------------------
// 2. apple-delivery toolpack gating: the SAME real registry pipeline (ToolRegistry.tools ->
//    KiloToolRegistry.applyVisibility) hides Apple tool ids for research-desk (toolpacks: []) and
//    shows them for ios-app-factory (toolpacks: ["apple-delivery"]). Mirrors the pattern in
//    test/kilocode/tool/toolpacks.test.ts (4.1).
// -------------------------------------------------------------------------------------------

const node = CrossSpawnSpawner.defaultLayer
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, ToolRegistry.defaultLayer, node))
const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}
const appleToolIds = [...TOOLPACKS["apple-delivery"].toolIds]

/** Copies ONLY the template's organization.jsonc into `dir/.kilo/organization.jsonc` - the file
 * KiloToolRegistry's toolpack gate actually reads (see registry.ts's toolpackEnabled). */
async function copyOrgFile(dir: string, templateName: string) {
  await fs.mkdir(path.join(dir, ".kilo"), { recursive: true })
  const source = path.join(TEMPLATES_DIR, templateName, "organization.jsonc")
  await fs.copyFile(source, OrgSchema.organizationPath(dir))
}

describe("EPIC 4 exit: apple-delivery toolpack gates tool visibility (the toolpack mechanism works)", () => {
  it.live("research-desk org (toolpacks: []) HIDES every Apple tool id from the real tool registry", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => copyOrgFile(dir, "research-desk"))

          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          for (const id of appleToolIds) expect(ids).not.toContain(id)
          // org_* tools stay visible - the org config exists, it just doesn't opt into Apple.
          expect(ids).toContain("org_start")
          // Generic tools are never gated by the pack.
          expect(ids).toContain("read")
        }),
      { git: true },
    ),
  )

  it.live("ios-app-factory org (toolpacks: [\"apple-delivery\"]) SHOWS every Apple tool id", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => copyOrgFile(dir, "ios-app-factory"))

          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          // LOAD-BEARING: the exact set of Apple tool ids the toolpack declares, sourced from the
          // real org file (not a hand-rolled inline org), all actually visible.
          for (const id of appleToolIds) expect(ids).toContain(id)
          expect(ids).toContain("org_start")
          expect(ids).toContain("read")
        }),
      { git: true },
    ),
  )
})

// -------------------------------------------------------------------------------------------
// 3. `org init --template research-desk` scaffolds a valid .kilo/ (handleInit is the exact
//    function the CLI's `northstar org init` command calls - src/kilocode/cli/cmd/org.ts).
// -------------------------------------------------------------------------------------------

function harness() {
  const logs: string[] = []
  const errors: string[] = []
  const codes: number[] = []
  return {
    logs,
    errors,
    codes,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
    exit: (code: number) => codes.push(code),
  }
}

describe("EPIC 4 exit: `org init --template research-desk` scaffolds a valid .kilo/", () => {
  test("scaffolds organization.jsonc + agents, and loadOrganization/validate/crossCheck are all clean", async () => {
    await using tmp = await tmpdir()
    const h = harness()

    await handleInit({
      template: "research-desk",
      force: false,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: h.log,
      error: h.error,
      exit: h.exit,
    })

    // No error path was taken.
    expect(h.errors).toEqual([])
    expect(h.codes).toEqual([])

    // The scaffold actually landed on disk.
    expect(existsSync(path.join(tmp.path, ".kilo", "organization.jsonc"))).toBe(true)
    expect(existsSync(path.join(tmp.path, ".kilo", "agents"))).toBe(true)
    for (const agentFile of ["ceo.md", "research-chief.md", "researcher.md", "review-chief.md", "reviewer.md"]) {
      expect(existsSync(path.join(tmp.path, ".kilo", "agents", agentFile))).toBe(true)
    }

    // LOAD-BEARING: re-run the exact validation chain handleInit performs internally, against the
    // scaffolded copy in the tmpdir - not the repo's own templates/ copy - so this fails loudly on
    // its own if the scaffold ever silently diverges from a valid org.
    const org = await OrgSchema.loadOrganization(tmp.path)
    const agents = await ConfigAgent.load(path.join(tmp.path, ".kilo"))
    const view = Object.fromEntries(
      Object.entries(agents).map(([agentName, a]) => [
        agentName,
        { mode: a.mode, subordinates: (a as { subordinates?: readonly string[] }).subordinates },
      ]),
    )
    expect(OrgSchema.validate(org)).toEqual([])
    expect(OrgSchema.crossCheck(org, view)).toEqual([])
    expect(org.toolpacks).toEqual([])

    const summary = h.logs.join("\n")
    expect(summary).toContain('"research-desk"')
    expect(summary).toContain(String(org.pipeline.length))
    expect(summary).toContain(String(Object.keys(agents).length))
  })

  test("the bundled templates dir actually lists research-desk (OrgTemplates.list, used by handleInit's own error path)", async () => {
    const available = await OrgTemplates.list(TEMPLATES_DIR)
    expect(available).toContain("research-desk")
  })
})
