import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgPrompts } from "../../../src/kilocode/organization/prompts"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgPlanTool } from "../../../src/kilocode/organization/tools"
import { MessageID, SessionID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Plugin } from "../../../src/plugin"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["planner"] },
    build: { chief: "build-chief", workers: ["builder"] },
  },
  pipeline: [{ stage: "plan", gate: "human" }, { stage: "build" }],
})

const plan = [
  { stage: "plan", objective: "Lock scope", criteria: ["Every stage has measurable evidence"], agents: ["planner"] },
  { stage: "build", objective: "Implement scope", criteria: ["Focused tests pass"], agents: ["builder"] },
]

const context = (agent: string) => ({
  sessionID: SessionID.make("ses_plan_test"),
  messageID: MessageID.make("msg_plan_test"),
  callID: "call_plan_test",
  agent,
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
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

async function seed(dir: string) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(ORG))
  const run = await OrgRunner.start(dir, ORG, "plan tool fixture")
  await OrgRunner.advance({ costOf: async () => 0 }, dir, ORG, run.runID, {})
  await Bun.write(OrgArtifacts.deliverablePath(dir, run.runID, "plan"), `draft ${"scope ".repeat(20)}`)
  await OrgRunner.advance({ costOf: async () => 0 }, dir, ORG, run.runID, { taskID: "ses_plan" })
  return run.runID
}

describe("org_plan", () => {
  test("renders a durable, human-readable approval document", () => {
    const markdown = OrgPrompts.planDocument(plan)
    expect(markdown).toContain("# Autonomous execution plan")
    expect(markdown).toContain("## build")
    expect(markdown).toContain("Objective: Implement scope")
    expect(markdown).toContain("- [ ] Focused tests pass")
    expect(markdown).toContain("Agents: builder")
  })

  test("CEO-only tool atomically commits editable criteria and rewrites the plan deliverable", async () => {
    await using tmp = await tmpdir()
    const runID = await seed(tmp.path)
    const runtime = makeRuntime()
    const tool = await runtime.runPromise(OrgPlanTool.pipe(Effect.flatMap((info) => info.init())))

    await provideTestInstance({
      directory: tmp.path,
      fn: () => runtime.runPromise(tool.execute({ run_id: runID, stages: plan }, context("ceo"))),
    })
    let state = await OrgState.read(tmp.path, runID)
    expect(state.auto).toBe(false)
    expect(state.stages.build.criteria).toEqual(["Focused tests pass"])
    expect(await Bun.file(OrgArtifacts.deliverablePath(tmp.path, runID, "plan")).text()).toContain("Focused tests pass")

    const edited = plan.map((entry) =>
      entry.stage === "build" ? { ...entry, criteria: ["All organization tests pass", "Typecheck is green"] } : entry,
    )
    await provideTestInstance({
      directory: tmp.path,
      fn: () => runtime.runPromise(tool.execute({ run_id: runID, stages: edited }, context("ceo"))),
    })
    state = await OrgState.read(tmp.path, runID)
    expect(state.stages.build.criteria).toEqual(["All organization tests pass", "Typecheck is green"])
    await runtime.dispose()
  })

  test("rejects a non-CEO caller before mutating state or the plan artifact", async () => {
    await using tmp = await tmpdir()
    const runID = await seed(tmp.path)
    const before = await Bun.file(OrgArtifacts.deliverablePath(tmp.path, runID, "plan")).text()
    const runtime = makeRuntime()
    const tool = await runtime.runPromise(OrgPlanTool.pipe(Effect.flatMap((info) => info.init())))

    await expect(
      provideTestInstance({
        directory: tmp.path,
        fn: () => runtime.runPromise(tool.execute({ run_id: runID, stages: plan }, context("worker"))),
      }),
    ).rejects.toThrow(/reserved for the CEO/i)
    expect((await OrgState.read(tmp.path, runID)).auto).toBeUndefined()
    expect(await Bun.file(OrgArtifacts.deliverablePath(tmp.path, runID, "plan")).text()).toBe(before)
    await runtime.dispose()
  })

  test("all bundled CEO templates require one-shot org_plan before the single approval", async () => {
    const root = path.resolve(import.meta.dir, "../../../../..")
    for (const name of ["blank", "content-studio", "ios-app-factory", "research-desk"]) {
      const text = await Bun.file(path.join(root, "templates", name, "agents", "ceo.md")).text()
      expect(text).toContain("org_plan")
      expect(text).toContain("acceptance criteria")
    }
  })
})
