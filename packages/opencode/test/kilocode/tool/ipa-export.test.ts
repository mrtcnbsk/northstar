// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import * as PlatformError from "effect/PlatformError"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { buildExportArgs, EXPORT_TIMEOUT_MS, IpaExportTool, listIpaFiles } from "../../../src/kilocode/tool/ipa-export"
import { StreamingXcodeParser } from "../../../src/kilocode/tool/xcodebuild-exec"
import { testEffect } from "../../lib/effect"
import { TestInstance, withTmpdirInstance } from "../../fixture/fixture"

const FAILED_EXPORT_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild -exportArchive -archivePath build/Keel.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export

error: exportArchive: No signing certificate matching team ID found
/path/to/nowhere.swift:1:1: error: no signing identity found

** EXPORT FAILED **
`

const SUCCEEDED_EXPORT_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild -exportArchive -archivePath build/Keel.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export

exportArchive
** EXPORT SUCCEEDED **
`

describe("buildExportArgs", () => {
  test("builds -exportArchive with archivePath/exportOptionsPlist/exportPath in order", () => {
    const args = buildExportArgs({
      archivePath: "build/Keel.xcarchive",
      exportOptionsPlist: "ExportOptions.plist",
      exportPath: "build/export",
    })
    expect(args).toEqual([
      "-exportArchive",
      "-archivePath",
      "build/Keel.xcarchive",
      "-exportOptionsPlist",
      "ExportOptions.plist",
      "-exportPath",
      "build/export",
    ])
  })

  test("appends extraArgs verbatim at the end", () => {
    const args = buildExportArgs({
      archivePath: "build/Keel.xcarchive",
      exportOptionsPlist: "ExportOptions.plist",
      exportPath: "build/export",
      extraArgs: ["-quiet"],
    })
    expect(args.slice(-1)).toEqual(["-quiet"])
  })
})

describe("listIpaFiles", () => {
  test("returns .ipa files sorted, as absolute paths, ignoring non-.ipa entries", () => {
    const dir = path.join(os.tmpdir(), "ipa-export-list-test-" + Math.random().toString(36).slice(2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "Zebra.ipa"), "")
    writeFileSync(path.join(dir, "App.ipa"), "")
    writeFileSync(path.join(dir, "notes.txt"), "")
    try {
      expect(listIpaFiles(dir)).toEqual([path.join(dir, "App.ipa"), path.join(dir, "Zebra.ipa")])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a missing directory yields an empty array instead of throwing", () => {
    expect(listIpaFiles("/definitely/does/not/exist/xyz")).toEqual([])
  })
})

// kilocode_change start - W7.1: StreamingXcodeParser parameterized with EXPORT markers
describe("StreamingXcodeParser with custom EXPORT markers", () => {
  test("detects ** EXPORT SUCCEEDED ** as success when constructed with export markers", () => {
    const parser = new StreamingXcodeParser(undefined, "** EXPORT SUCCEEDED **", "** EXPORT FAILED **")
    parser.push(SUCCEEDED_EXPORT_FIXTURE)
    parser.finish()
    expect(parser.result(0).ok).toBe(true)
  })

  test("detects ** EXPORT FAILED ** as failure, with the file:line:col diagnostic parsed", () => {
    const parser = new StreamingXcodeParser(undefined, "** EXPORT SUCCEEDED **", "** EXPORT FAILED **")
    parser.push(FAILED_EXPORT_FIXTURE)
    parser.finish()
    const result = parser.result(1)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].message).toBe("no signing identity found")
  })
})
// kilocode_change end

// ---- Effect-harness tests for the execute path ----

const encoder = new TextEncoder()

const harness = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Truncate.defaultLayer, Config.defaultLayer, Agent.defaultLayer),
)

function fakeHandle(
  all: ChildProcessSpawner.ChildProcessHandle["all"],
  exit = 0,
  overrides: {
    exitCode?: ChildProcessSpawner.ChildProcessHandle["exitCode"]
    kill?: ChildProcessSpawner.ChildProcessHandle["kill"]
  } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    exitCode: overrides.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
    isRunning: Effect.succeed(true),
    kill: overrides.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "code",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const defaultParams = {
  archivePath: "build/Keel.xcarchive",
  exportOptionsPlist: "ExportOptions.plist",
  exportPath: "build/export",
}

const runExecute = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  params: Record<string, unknown> = defaultParams,
) =>
  Effect.gen(function* () {
    const info = yield* IpaExportTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("IpaExportTool execute: spawn failure vs export failure vs export success", () => {
  harness.instance("spawn failure yields status:spawn_failed with the message, NOT an empty export failure", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "Command",
            method: "spawn",
            pathOrDescriptor: "xcodebuild",
            description: "spawn xcodebuild ENOENT",
          }),
        ),
      )
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("spawn_failed")
      expect(summary.ok).toBe(false)
      expect(summary.error).toContain("xcodebuild")
      expect(summary.ipaPaths).toBeUndefined()
    }),
  )

  harness.instance("an export failure yields status:export_failed with parsed diagnostics and NO ipaPaths", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(FAILED_EXPORT_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 1)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("export_failed")
      expect(summary.ok).toBe(false)
      expect(summary.errorCount).toBe(1)
      expect(summary.ipaPaths).toBeUndefined()
      expect(typeof summary.rawLogPath).toBe("string")
    }),
  )

  harness.instance("an export success lists the produced .ipa file(s) under exportPath", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const exportDir = path.join(test.directory, "build", "export")
      mkdirSync(exportDir, { recursive: true })
      writeFileSync(path.join(exportDir, "App.ipa"), "")

      const all = Stream.make(encoder.encode(SUCCEEDED_EXPORT_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("export_succeeded")
      expect(summary.ok).toBe(true)
      expect(summary.ipaPaths).toEqual([path.join(exportDir, "App.ipa")])
      expect(result.metadata.ipaPaths).toEqual([path.join(exportDir, "App.ipa")])
    }),
  )

  harness.instance("an export success with no .ipa produced yields ipaPaths: [] (still export_succeeded)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      mkdirSync(path.join(test.directory, "build", "export"), { recursive: true })

      const all = Stream.make(encoder.encode(SUCCEEDED_EXPORT_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("export_succeeded")
      expect(summary.ipaPaths).toEqual([])
    }),
  )
})

// kilocode_change start - W7.1: within-project path-param validation (archivePath/
// exportOptionsPlist/exportPath)
describe("IpaExportTool execute: path-param validation", () => {
  harness.instance("a '..'-traversal exportPath yields status:invalid_args and NEVER spawns xcodebuild", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { ...defaultParams, exportPath: "../../etc/export" })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(spawnCalled).toBe(false)
    }),
  )

  harness.instance("an absolute exportOptionsPlist OUTSIDE the project yields status:invalid_args and NEVER spawns", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { ...defaultParams, exportOptionsPlist: "/etc/ExportOptions.plist" })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(spawnCalled).toBe(false)
    }),
  )

  harness.instance("a disallowed extraArg is still rejected (shared validateExtraArgs) and NEVER spawns", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { ...defaultParams, extraArgs: ["-xcconfig", "/etc/build.xcconfig"] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(spawnCalled).toBe(false)
    }),
  )
})
// kilocode_change end

// kilocode_change start - W7.1: timeout via TestClock, mirroring xcode_build's timeout coverage
describe("IpaExportTool execute: timeout", () => {
  harness.effect("an export that runs past the timeout is terminated and returns status:export_failed", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          fakeHandle(Stream.empty, 0, {
            exitCode: Effect.never,
            kill: () => Effect.void,
          }),
        ),
      )
      const fiber = yield* runExecute(spawner).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(`${EXPORT_TIMEOUT_MS + 1000} millis`)

      const result = yield* Fiber.join(fiber)
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("export_failed")
      expect(result.metadata.ok).toBe(false)
    }).pipe(withTmpdirInstance()),
  )
})
// kilocode_change end
