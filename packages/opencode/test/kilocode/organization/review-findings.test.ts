// kilocode_change - new file: regression tests pinning the org-runtime review findings.
//   #1  org_advance is a no-op while a headless autonomous driver is attached (no dual-drive)
//   #2  a pause landing mid-flight preserves the chief taskID so its cost still lands in budget
//   #6  an irreversible approval authorizes ONLY the stage it was minted for
//   #13 org_start never overwrites a live run's state.json on a same-second, same-idea collision
import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdir } from "node:fs/promises"
import path from "path"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgAdvanceTool } from "../../../src/kilocode/organization/tools"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgDriver } from "../../../src/kilocode/organization/driver"
import { Session } from "../../../src/session/session"
import { SessionID, MessageID } from "../../../src/session/schema"
import { Truncate } from "../../../src/tool/truncate"
import { Agent } from "../../../src/agent/agent"
import { Config } from "../../../src/config/config"
import { Plugin } from "../../../src/plugin"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"

async function writeDeliverable(dir: string, runID: string, stage: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `# ${stage}\n\n${"positive evidence ".repeat(12)}`)
}

describe("Finding #13: org_start runID collision", () => {
  test("concurrent same-idea creates never collide or clobber a live run", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: { work: { chief: "work-chief", workers: ["worker"] } },
      pipeline: [{ stage: "work" }],
    })
    // Five concurrent starts with the identical idea land in the same wall-clock second and derive the
    // same base runID; the atomic dir reservation must hand each a distinct run instead of overwriting.
    const runs = await Promise.all(Array.from({ length: 5 }, () => OrgState.create(tmp.path, org, "same exact idea")))
    const ids = runs.map((r) => r.runID)
    expect(new Set(ids).size).toBe(5)
    for (const id of ids) {
      const persisted = await OrgState.read(tmp.path, id)
      expect(persisted.idea).toBe("same exact idea")
    }
    const listed = await OrgState.list(tmp.path)
    for (const id of ids) expect(listed).toContain(id)
  })
})

describe("Finding #2: pause must not drop an in-flight chief taskID", () => {
  test("a pause landing while a chief is in flight preserves the taskID so its cost is recorded on resume", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: { work: { chief: "work-chief", workers: ["worker"] } },
      pipeline: [{ stage: "work" }],
    })
    const run = await OrgRunner.start(tmp.path, org, "pause cost idea")
    const deps = { costOf: async (id: string) => (id === "ses_work" ? 3 : undefined) }
    await OrgRunner.advance(deps, tmp.path, org, run.runID, {}) // work -> running
    await writeDeliverable(tmp.path, run.runID, "work")

    // Operator pauses while the chief is still in flight (work running, no taskID persisted yet).
    await OrgRunner.pause(tmp.path, org, run.runID, { kind: "manual", stage: "none", detail: "paused mid-flight" })
    // The conductor reports the finished chief while the run is paused — the taskID must NOT be dropped.
    await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskResults: [{ stage: "work", taskID: "ses_work" }] })
    const paused = await OrgState.read(tmp.path, run.runID)
    expect(paused.stages.work.taskID).toBe("ses_work")

    // Resume and settle: the cost lands because the taskID survived the pause.
    await OrgRunner.resume(tmp.path, org, run.runID)
    await OrgRunner.advance(deps, tmp.path, org, run.runID, {})
    const settled = await OrgState.read(tmp.path, run.runID)
    expect(settled.stages.work.costs?.["ses_work"]).toBe(3)
  })
})

describe("Finding #6: irreversible approval is bound to its stage", () => {
  test("approving a sibling awaiting stage neither mints an approval nor dissolves the paused final gate", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        x: { chief: "x-chief", workers: ["xw"] },
        y: { chief: "y-chief", workers: ["yw"] },
      },
      pipeline: [{ stage: "x" }, { stage: "y" }],
      maxConcurrency: 2,
    })
    const run = await OrgRunner.start(tmp.path, org, "sibling gate idea")
    // Hand-craft the parallel-DAG state: the run is paused at x's final gate while a sibling y is also
    // awaiting approval (both would be awaiting at once under maxConcurrency>1).
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.auto = true
      s.status = "paused"
      s.pausedReason = { kind: "final_gate", stage: "x", detail: "x gated on an irreversible action" }
      s.stages.x.status = "awaiting_approval"
      s.stages.y.status = "awaiting_approval"
    })

    // Approve the SIBLING y — NOT the gated x.
    await OrgRunner.decide(tmp.path, org, run.runID, "approve", undefined, "y")
    const state = await OrgState.read(tmp.path, run.runID)

    // No cross-stage approval was minted, and x's final gate is still intact.
    expect(state.irreversibleApproval).toBeUndefined()
    expect(state.status).toBe("paused")
    expect(state.pausedReason?.stage).toBe("x")
    expect(state.stages.x.status).toBe("awaiting_approval")
    // y itself is resolved.
    expect(state.stages.y.status).toBe("completed")
  })
})

describe("Finding: plan gate is the first human-gated stage, not blindly pipeline[0]", () => {
  test("an org with an ungated pre-plan stage commits its plan and arms autonomous mode at the human gate", async () => {
    await using tmp = await tmpdir()
    // Shape mirrors ios-app-factory: an ungated "evaluation" pass precedes the human "planning" gate.
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        evaluation: { chief: "eval-chief", workers: ["analyst"] },
        planning: { chief: "plan-chief", workers: ["architect"] },
        build: { chief: "build-chief", workers: ["builder"] },
      },
      pipeline: [
        { stage: "evaluation", criteria: ["evaluation evidence"] },
        { stage: "planning", gate: "human", criteria: ["plan evidence"] },
        { stage: "build", requires: ["planning"], criteria: ["build evidence"] },
      ],
    })
    const run = await OrgRunner.start(tmp.path, org, "eval-first idea")
    const deps = { costOf: async () => 1 }
    // Drive to the planning gate: evaluation runs (ungated -> completed), then planning gates.
    await OrgRunner.advance(deps, tmp.path, org, run.runID, {}) // instruct evaluation
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskResults: [{ stage: "evaluation", taskID: "ses_eval" }] })
    await writeDeliverable(tmp.path, run.runID, "planning")
    await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskResults: [{ stage: "planning", taskID: "ses_plan" }] })

    let state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages.evaluation.status).toBe("completed")
    expect(state.stages.planning.status).toBe("awaiting_approval")

    // commitPlan must NOT throw even though pipeline[0] ("evaluation") is completed, not awaiting.
    const PLAN = org.pipeline.map((s) => ({
      stage: s.stage,
      objective: `do ${s.stage}`,
      criteria: [`${s.stage} evidence`],
      agents: [],
    }))
    await OrgRunner.commitPlan(tmp.path, org, run.runID, PLAN)
    // Approving the planning gate arms autonomous mode, even though planning is not pipeline[0].
    await OrgRunner.decide(tmp.path, org, run.runID, "approve", undefined, "planning")

    state = await OrgState.read(tmp.path, run.runID)
    expect(state.auto).toBe(true)
    expect(state.stages.planning.status).toBe("completed")
  })
})

const sessionStub = Session.Service.of({
  list: () => Effect.die("unused"),
  create: () => Effect.die("unused"),
  fork: () => Effect.die("unused"),
  touch: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  setTitle: () => Effect.die("unused"),
  setArchived: () => Effect.die("unused"),
  setMetadata: () => Effect.die("unused"),
  setPermission: () => Effect.die("unused"),
  setRevert: () => Effect.die("unused"),
  clearRevert: () => Effect.die("unused"),
  setSummary: () => Effect.die("unused"),
  diff: () => Effect.die("unused"),
  messages: () => Effect.die("unused"),
  children: () => Effect.die("unused"),
  remove: () => Effect.die("unused"),
  updateMessage: () => Effect.die("unused"),
  removeMessage: () => Effect.die("unused"),
  removePart: () => Effect.die("unused"),
  getPart: () => Effect.die("unused"),
  updatePart: () => Effect.die("unused"),
  updatePartDelta: () => Effect.die("unused"),
  findMessage: () => Effect.die("unused"),
})

const ctx = {
  sessionID: SessionID.make("ses_owner"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "ceo",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("Finding #1: org_advance does not double-drive an autonomous run", () => {
  test("returns an autonomous no-op (no advance) while a headless driver flight is attached", async () => {
    await using tmp = await tmpdir()
    const org = OrgSchema.parse({
      ceo: "ceo",
      departments: { build: { chief: "build-chief", workers: ["builder"] } },
      pipeline: [{ stage: "build" }],
      loop: { maxIterations: 2, evaluatorModel: "haiku" },
    })
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(OrgSchema.organizationPath(tmp.path), JSON.stringify(org))
    const run = await OrgRunner.start(tmp.path, org, "dual controller idea", undefined, "ses_owner")
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.auto = true
      s.stages.build.objective = "Complete build"
      s.stages.build.criteria = ["build evidence"]
    })

    // Block the driver mid-flight (chief in flight) so its flight stays attached for the tool call.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime: OrgDriver.Runtime = {
      costOf: async () => 0,
      spawnChief: async ({ runID, stage }) => {
        await writeDeliverable(tmp.path, runID, stage)
        await gate
        return { taskID: `ses_${stage}`, cost: 0, toolIDs: [] }
      },
      evaluate: async () => '{"pass":true,"summary":"ok"}',
    }
    const flight = OrgDriver.attach({ projectDir: tmp.path, org, runID: run.runID, runtime })
    expect(OrgDriver.isAttached(tmp.path, run.runID)).toBe(true)

    const runtimeEffect = ManagedRuntime.make(
      Layer.mergeAll(
        CrossSpawnSpawner.defaultLayer,
        AppFileSystem.defaultLayer,
        Plugin.defaultLayer,
        Truncate.defaultLayer,
        Agent.defaultLayer,
        Config.defaultLayer,
        RuntimeFlags.layer(),
        Layer.succeed(Session.Service, sessionStub),
      ),
    )
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtimeEffect.runPromise(OrgAdvanceTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(tool.execute({ run_id: run.runID }, ctx))
        const body = JSON.parse(out.output)
        expect(body.action).toBe("autonomous")
      },
    })

    release()
    await flight.catch(() => {})
  })
})
