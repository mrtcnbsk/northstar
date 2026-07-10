// kilocode_change - new file
// Tool-level tests for org_stop's best-effort cancel path. The malformed-taskID guard lives in
// tools.ts (OrgRunner.stop never calls SessionID.make), so this is the smallest seam that
// actually exercises it: a real execute() against a stub SessionRunState, with the taskID
// persisted unvalidated the way org_advance persists model input.
import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgStopTool } from "../../../src/kilocode/organization/tools"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { SessionRunState } from "../../../src/session/run-state"
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

const deps = { costOf: async () => undefined }

function makeRuntime(cancelled: string[]) {
  return ManagedRuntime.make(
    Layer.mergeAll(
      CrossSpawnSpawner.defaultLayer,
      AppFileSystem.defaultLayer,
      Plugin.defaultLayer,
      Truncate.defaultLayer,
      Agent.defaultLayer,
      Config.defaultLayer,
      RuntimeFlags.layer(),
      Layer.succeed(
        SessionRunState.Service,
        SessionRunState.Service.of({
          assertNotBusy: () => Effect.void,
          cancel: (id) =>
            Effect.sync(() => {
              cancelled.push(id)
            }),
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

async function seedRun(dir: string) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(ORG))
  const run = await OrgRunner.start(dir, ORG, "stop tool idea")
  await OrgRunner.advance(deps, dir, ORG, run.runID, {}) // eng -> running
  return run
}

describe("org_stop tool cancel path", () => {
  test("malformed persisted taskID does not throw: run halts and cancel is skipped", async () => {
    await using tmp = await tmpdir()
    const run = await seedRun(tmp.path)
    // org_advance persists model-provided task ids unvalidated; simulate one that is not a session id
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["eng"].taskID = "not-a-session"
    })

    const cancelled: string[] = []
    const runtime = makeRuntime(cancelled)
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgStopTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(tool.execute({ run_id: run.runID, reason: "abort now" }, ctx))
        const body = JSON.parse(out.output)
        expect(body.action).toBe("stopped")
        expect(body.reason).toBe("abort now")
        expect(body.cancelled_session).toBeUndefined()
        expect(body.note).toContain("cancellation failed")
      },
    })

    // the guard skipped the cancel entirely (no swallowed synchronous SessionID.make throw)
    expect(cancelled).toEqual([])
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
    expect(state.haltReason).toBe("emergency stop: abort now")
  })

  test("valid taskID is cancelled and reported", async () => {
    await using tmp = await tmpdir()
    const run = await seedRun(tmp.path)
    await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["eng"].taskID = "ses_chief"
    })

    const cancelled: string[] = []
    const runtime = makeRuntime(cancelled)
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgStopTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(tool.execute({ run_id: run.runID, reason: "user said stop" }, ctx))
        const body = JSON.parse(out.output)
        expect(body.action).toBe("stopped")
        expect(body.cancelled_session).toBe("ses_chief")
        expect(body.note).toContain("cancelled")
      },
    })
    expect(cancelled).toEqual(["ses_chief"])
  })

  test("running stage without a recorded task session gets a distinct note naming the stage", async () => {
    await using tmp = await tmpdir()
    const run = await seedRun(tmp.path) // eng running, no taskID ever reported

    const runtime = makeRuntime([])
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgStopTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(tool.execute({ run_id: run.runID, reason: "abort" }, ctx))
        const body = JSON.parse(out.output)
        expect(body.action).toBe("stopped")
        expect(body.note).toBe('stage "eng" was running but no task session was recorded; nothing to cancel')
      },
    })
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("halted")
  })

  test("no running stage gets the plain no-stage note", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(OrgSchema.organizationPath(tmp.path), JSON.stringify(ORG))
    const run = await OrgRunner.start(tmp.path, ORG, "never advanced") // all stages pending

    const runtime = makeRuntime([])
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgStopTool.pipe(Effect.flatMap((info) => info.init())))
        const out = await Effect.runPromise(tool.execute({ run_id: run.runID, reason: "abort" }, ctx))
        const body = JSON.parse(out.output)
        expect(body.action).toBe("stopped")
        expect(body.note).toBe("no stage was running")
      },
    })
  })
})
