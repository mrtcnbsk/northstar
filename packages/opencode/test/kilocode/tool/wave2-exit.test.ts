// kilocode_change - new file (W2.7): Wave 2 exit integration test.
//
// This is the TOOL-LEVEL exit proof for Wave 2 (build & test runtime). It drives the three
// structured tools' execute() end-to-end through the same ChildProcessSpawner stub harness the
// per-tool tests use — NO Xcode required, fully fixture-driven — and asserts each returns the
// structured shape a chief/worker agent would actually consume:
//
//   1. xcode_build FAILURE  → { ok:false, status:"build_failed", errors:[{file,line,message}] }
//   2. xcode_build SUCCESS  → { ok:true,  status:"build_succeeded" }
//   3. xcode_test FAILURE   → { ok:false, status:"tests_failed", failed:[...], passed:N }
//   4. crash_symbolicate    → resolved trace with framesResolved > 0
//   5. argv denylist        → { status:"invalid_args" } and NO spawn
//
// The org-run-level exit proof (a full chief→worker org run over these tools) lives in the
// organization suite; this file proves the tool contracts those runs depend on in isolation.
import { describe, expect } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { XcodeBuildTool } from "../../../src/kilocode/tool/xcode-build"
import { XcodeTestTool } from "../../../src/kilocode/tool/xcode-test"
import { CrashSymbolicateTool } from "../../../src/kilocode/tool/crash-symbolicate"
import { testEffect } from "../../lib/effect"

const encoder = new TextEncoder()

// ---- Fixtures (self-contained; mirror the realistic shapes used in the per-tool suites) ----

const BUILD_FAILED_FIXTURE = `
CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:42:15: error: cannot find 'HashChain' in scope
    let chain = HashChain(seed: seed)
                ^~~~~~~~~
** BUILD FAILED **

The following build commands failed:
	CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
(1 failure)
`

const BUILD_SUCCEEDED_FIXTURE = `
CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
Ld /Users/dev/keel/build/Debug/Keel.app/Contents/MacOS/Keel normal
** BUILD SUCCEEDED **
`

const TESTS_FAILED_FIXTURE = `
Test Suite 'All tests' started at 2026-07-09 10:05:00.000.
Test Case '-[LedgerStoreTests testAppendEntry]' started.
Test Case '-[LedgerStoreTests testAppendEntry]' passed (0.012 seconds).
Test Case '-[LedgerStoreTests testHashChainIntegrity]' started.
/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift:58: error: -[LedgerStoreTests testHashChainIntegrity] : XCTAssertEqual failed: ("abc123") is not equal to ("def456")
Test Case '-[LedgerStoreTests testHashChainIntegrity]' failed (0.021 seconds).
	 Executed 2 tests, with 1 failure (0 unexpected) in 0.033 (0.035) seconds
** TEST FAILED **
`

const CRASH_LOG_FIXTURE = `Process:              Keel [1234]
Identifier:            com.ilura.keel
Code Type:             ARM-64
Triggered by Thread:  0

Thread 0 Crashed:
0   Keel                          0x0000000104f2c1a0 0x104f28000 + 16800
1   Keel                          0x0000000104f30bf4 0x104f28000 + 34292
2   UIKitCore                      0x00000001a2b4c9d8 0x1a2000000 + 12345432

Binary Images:
0x104f28000 - 0x104f5ffff Keel arm64  <a1b2c3d4e5f647a8b9c0d1e2f3a4b5c6> /var/containers/Bundle/Application/XXXX/Keel.app/Keel
0x1a2000000 - 0x1a4ffffff UIKitCore arm64  <11223344556677889900aabbccddeeff> /System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore
`

// ---- Harness (identical wiring to the per-tool execute tests) ----

const harness = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Truncate.defaultLayer, Config.defaultLayer, Agent.defaultLayer),
)

function fakeHandle(all: ChildProcessSpawner.ChildProcessHandle["all"], exit = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
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

const runBuild = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* XcodeBuildTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

const runTest = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* XcodeTestTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

const runSymbolicate = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  params: { crashLog: string; dsymPath: string },
) =>
  Effect.gen(function* () {
    const info = yield* CrashSymbolicateTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("Wave 2 exit criteria (tool-level, fixture-driven, no Xcode)", () => {
  harness.instance("1. xcode_build FAILURE → { ok:false, status:build_failed, errors:[{file,line,message}] } an agent can act on", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(BUILD_FAILED_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 65)))
      const result = yield* runBuild(spawner, { scheme: "Keel" })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("build_failed")
      // The structured, actionable diagnostic: a worker can open the file at the line and fix it.
      expect(summary.errors).toHaveLength(1)
      expect(summary.errors[0]).toEqual({
        file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
        line: 42,
        column: 15,
        severity: "error",
        message: "cannot find 'HashChain' in scope",
      })
      expect(result.metadata.status).toBe("build_failed")
    }),
  )

  harness.instance("2. xcode_build SUCCESS → { ok:true, status:build_succeeded }", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(BUILD_SUCCEEDED_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runBuild(spawner, { scheme: "Keel" })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.status).toBe("build_succeeded")
      expect(summary.errorCount).toBe(0)
      expect(result.metadata.status).toBe("build_succeeded")
    }),
  )

  harness.instance("3. xcode_test failing test → { ok:false, status:tests_failed, failed:[...], passed:N }", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(TESTS_FAILED_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 1)))
      const result = yield* runTest(spawner, { scheme: "Keel" })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("tests_failed")
      expect(summary.passed).toBe(1)
      expect(summary.failed).toHaveLength(1)
      expect(summary.failed[0]).toEqual({
        test: "LedgerStoreTests.testHashChainIntegrity",
        file: "/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift",
        line: 58,
        message: 'XCTAssertEqual failed: ("abc123") is not equal to ("def456")',
      })
      expect(result.metadata.status).toBe("tests_failed")
    }),
  )

  harness.instance("4. crash_symbolicate crash log + stubbed atos → resolved trace, framesResolved > 0", () => {
    // The tool resolves a real .dSYM bundle path, so materialize one for the fixture.
    const dsymDir = mkdtempSync(path.join(tmpdir(), "wave2-exit-dsym-"))
    const dwarf = path.join(dsymDir, "Keel.app.dSYM", "Contents", "Resources", "DWARF")
    mkdirSync(dwarf, { recursive: true })
    writeFileSync(path.join(dwarf, "Keel"), "fake-binary")
    return Effect.gen(function* () {
      // Stubbed atos: resolves both Keel app frames to symbol lines.
      const atosOutput = [
        "LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)",
        "main (in Keel) (main.swift:10)",
      ].join("\n")
      const all = Stream.make(encoder.encode(atosOutput))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runSymbolicate(spawner, {
        crashLog: CRASH_LOG_FIXTURE,
        dsymPath: path.join(dsymDir, "Keel.app.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.framesResolved).toBeGreaterThan(0)
      expect(summary.symbolicated).toContain("LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)")
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(dsymDir, { recursive: true, force: true }))))
  })

  harness.instance("5. argv denylist: a dangerous extraArg → { status:invalid_args } and NO spawn", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runBuild(spawner, { scheme: "Keel", extraArgs: ["-derivedDataPath", "/etc"] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      // The blast-radius guard fires BEFORE any process is launched.
      expect(spawnCalled).toBe(false)
      expect(result.metadata.status).toBe("invalid_args")
    }),
  )
})
