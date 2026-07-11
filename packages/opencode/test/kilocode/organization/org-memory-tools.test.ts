// kilocode_change - new file
// W6.1: tool-level coverage for org_memory_save/org_recall. Mirrors stop-tool.test.ts's
// ManagedRuntime harness (the smallest seam that runs a real Tool.execute()), minus
// SessionRunState.Service, which neither tool touches.
import { describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import { provideTestInstance, tmpdir } from "../../fixture/fixture"
import { OrgMemorySaveTool } from "../../../src/kilocode/tool/org-memory-save"
import { OrgRecallTool } from "../../../src/kilocode/tool/org-recall"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
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

describe("org_memory_save / org_recall tools", () => {
  test("org_memory_save is registered under the org_ id prefix (visibility + primary-mode gates apply)", async () => {
    const runtime = makeRuntime()
    const info = await runtime.runPromise(OrgMemorySaveTool)
    expect(info.id).toBe("org_memory_save")
    expect(info.id.startsWith("org_")).toBe(true)
  })

  test("org_recall is registered under the org_ id prefix (visibility + primary-mode gates apply)", async () => {
    const runtime = makeRuntime()
    const info = await runtime.runPromise(OrgRecallTool)
    expect(info.id).toBe("org_recall")
    expect(info.id.startsWith("org_")).toBe(true)
  })

  test("org_memory_save rejects a non-CEO agent", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgMemorySaveTool.pipe(Effect.flatMap((info) => info.init())))
        const exit = await Effect.runPromiseExit(tool.execute({ text: "a lesson" }, ctxFor("worker")))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Cause.squash(exit.cause)
        expect((error as Error).message).toContain('org tools are reserved for the CEO agent "ceo"')
      },
    })
  })

  test("org_recall rejects a non-CEO agent", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const tool = await runtime.runPromise(OrgRecallTool.pipe(Effect.flatMap((info) => info.init())))
        const exit = await Effect.runPromiseExit(tool.execute({ query: "anything" }, ctxFor("worker")))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isSuccess(exit)) return
        const error = Cause.squash(exit.cause)
        expect((error as Error).message).toContain('org tools are reserved for the CEO agent "ceo"')
      },
    })
  })

  test("the CEO agent can save and then recall it back, dept-scoped", async () => {
    await using tmp = await tmpdir()
    await seedOrg(tmp.path)

    const runtime = makeRuntime()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const saveTool = await runtime.runPromise(OrgMemorySaveTool.pipe(Effect.flatMap((info) => info.init())))
        const recallTool = await runtime.runPromise(OrgRecallTool.pipe(Effect.flatMap((info) => info.init())))

        const saveOut = await Effect.runPromise(
          saveTool.execute({ text: "The eng ship gate needs a budget check.", dept: "eng" }, ctxFor("ceo")),
        )
        const saveBody = JSON.parse(saveOut.output)
        expect(saveBody.ok).toBe(true)

        const recallOut = await Effect.runPromise(
          recallTool.execute({ query: "ship gate budget check", dept: "eng" }, ctxFor("ceo")),
        )
        const recallBody = JSON.parse(recallOut.output)
        expect(recallBody.count).toBe(1)
        expect(recallBody.hits[0].text).toContain("[dept::eng]")
      },
    })
  })
})
