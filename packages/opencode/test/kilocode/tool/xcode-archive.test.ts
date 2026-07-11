// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import * as PlatformError from "effect/PlatformError"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { ARCHIVE_TIMEOUT_MS, buildArchiveArgs, XcodeArchiveTool } from "../../../src/kilocode/tool/xcode-archive"
import { StreamingXcodeParser } from "../../../src/kilocode/tool/xcodebuild-exec"
import { testEffect } from "../../lib/effect"
import { withTmpdirInstance } from "../../fixture/fixture"

const FAILED_ARCHIVE_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild archive -workspace Keel.xcworkspace -scheme Keel -archivePath build/Keel.xcarchive

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:42:15: error: cannot find 'HashChain' in scope
    let chain = HashChain(seed: seed)
                ^~~~~~~~~

** ARCHIVE FAILED **

The following build commands failed:
	CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
(1 failure)
`

const SUCCEEDED_ARCHIVE_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild archive -workspace Keel.xcworkspace -scheme Keel -archivePath build/Keel.xcarchive

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:12:5: warning: variable 'unused' was never used; consider replacing with '_'
    var unused = 0
        ^

** ARCHIVE SUCCEEDED **

`

describe("buildArchiveArgs", () => {
  test("includes scheme, workspace, configuration, archivePath in order", () => {
    const args = buildArchiveArgs({
      scheme: "Keel",
      workspace: "Keel.xcworkspace",
      configuration: "Release",
      archivePath: "build/Keel.xcarchive",
    })
    expect(args).toEqual([
      "archive",
      "-scheme",
      "Keel",
      "-workspace",
      "Keel.xcworkspace",
      "-configuration",
      "Release",
      "-archivePath",
      "build/Keel.xcarchive",
    ])
  })

  test("includes project instead of workspace when project is given, omits configuration when absent", () => {
    const args = buildArchiveArgs({ scheme: "Keel", project: "Keel.xcodeproj", archivePath: "build/Keel.xcarchive" })
    expect(args).toEqual(["archive", "-scheme", "Keel", "-project", "Keel.xcodeproj", "-archivePath", "build/Keel.xcarchive"])
  })

  test("appends extraArgs verbatim at the end", () => {
    const args = buildArchiveArgs({
      scheme: "Keel",
      archivePath: "build/Keel.xcarchive",
      extraArgs: ["-quiet", "CODE_SIGNING_ALLOWED=NO"],
    })
    expect(args).toEqual([
      "archive",
      "-scheme",
      "Keel",
      "-archivePath",
      "build/Keel.xcarchive",
      "-quiet",
      "CODE_SIGNING_ALLOWED=NO",
    ])
  })
})

// kilocode_change start - W7.1: StreamingXcodeParser parameterized with ARCHIVE markers (unit
// tests the marker parameterization itself, independent of the xcode_archive tool).
describe("StreamingXcodeParser with custom ARCHIVE markers", () => {
  test("detects ** ARCHIVE SUCCEEDED ** as success when constructed with archive markers", () => {
    const parser = new StreamingXcodeParser(undefined, "** ARCHIVE SUCCEEDED **", "** ARCHIVE FAILED **")
    parser.push(SUCCEEDED_ARCHIVE_FIXTURE)
    parser.finish()
    const result = parser.result(0)
    expect(result.ok).toBe(true)
    expect(result.buildSucceeded).toBe(true)
    expect(result.warnings).toHaveLength(1)
  })

  test("detects ** ARCHIVE FAILED ** as failure when constructed with archive markers", () => {
    const parser = new StreamingXcodeParser(undefined, "** ARCHIVE SUCCEEDED **", "** ARCHIVE FAILED **")
    parser.push(FAILED_ARCHIVE_FIXTURE)
    parser.finish()
    const result = parser.result(65)
    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toHaveLength(1)
  })

  test("a bare '** BUILD SUCCEEDED **' banner is NOT mistaken for archive success (markers are exact)", () => {
    const parser = new StreamingXcodeParser(undefined, "** ARCHIVE SUCCEEDED **", "** ARCHIVE FAILED **")
    parser.push("Command line invocation\n** BUILD SUCCEEDED **\n")
    parser.finish()
    const result = parser.result(0)
    expect(result.buildSucceeded).toBe(false)
    expect(result.ok).toBe(false)
  })

  test("default constructor (no markers passed) still matches BUILD SUCCEEDED/FAILED, unchanged", () => {
    const parser = new StreamingXcodeParser()
    parser.push("** BUILD SUCCEEDED **\n")
    parser.finish()
    expect(parser.result(0).buildSucceeded).toBe(true)
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

const runExecute = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  params: Record<string, unknown> = { scheme: "Keel", archivePath: "build/Keel.xcarchive" },
) =>
  Effect.gen(function* () {
    const info = yield* XcodeArchiveTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("XcodeArchiveTool execute: spawn failure vs archive failure vs archive success", () => {
  harness.instance("spawn failure yields status:spawn_failed with the message, NOT an empty archive failure", () =>
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
      expect(summary.archivePath).toBeUndefined()
      expect(result.metadata.status).toBe("spawn_failed")
    }),
  )

  harness.instance("an archive failure yields status:archive_failed with parsed diagnostics and a raw log", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(FAILED_ARCHIVE_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 65)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("archive_failed")
      expect(summary.ok).toBe(false)
      expect(summary.errorCount).toBe(1)
      expect(summary.archivePath).toBeUndefined()
      expect(typeof summary.rawLogPath).toBe("string")
    }),
  )

  harness.instance("an archive success yields status:archive_succeeded and echoes archivePath", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(SUCCEEDED_ARCHIVE_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("archive_succeeded")
      expect(summary.ok).toBe(true)
      expect(summary.archivePath).toBe("build/Keel.xcarchive")
      expect(summary.warningCount).toBe(1)
      expect(result.metadata.archivePath).toBe("build/Keel.xcarchive")
    }),
  )
})

// kilocode_change start - W7.1: within-project path-param validation (archivePath)
describe("XcodeArchiveTool execute: archivePath validation", () => {
  harness.instance("a '..'-traversal archivePath yields status:invalid_args and NEVER spawns xcodebuild", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { scheme: "Keel", archivePath: "../../etc/Keel.xcarchive" })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(spawnCalled).toBe(false)
      expect(result.metadata.status).toBe("invalid_args")
    }),
  )

  harness.instance("an absolute archivePath OUTSIDE the project yields status:invalid_args and NEVER spawns", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { scheme: "Keel", archivePath: "/etc/Keel.xcarchive" })
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
      const result = yield* runExecute(spawner, {
        scheme: "Keel",
        archivePath: "build/Keel.xcarchive",
        extraArgs: ["-derivedDataPath", "/etc"],
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(spawnCalled).toBe(false)
    }),
  )
})
// kilocode_change end

// kilocode_change start - W7.1: timeout via TestClock, mirroring xcode_build's timeout coverage
describe("XcodeArchiveTool execute: timeout", () => {
  harness.effect("an archive that runs past the timeout is terminated and returns status:archive_failed", () =>
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
      yield* TestClock.adjust(`${ARCHIVE_TIMEOUT_MS + 1000} millis`)

      const result = yield* Fiber.join(fiber)
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("archive_failed")
      expect(result.metadata.ok).toBe(false)
    }).pipe(withTmpdirInstance()),
  )
})
// kilocode_change end
