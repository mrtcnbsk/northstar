// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import * as PlatformError from "effect/PlatformError"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import {
  buildTestArgs,
  MAX_DIAGNOSTICS,
  MAX_RETAINED_TAIL_BYTES,
  parseXcodeTestOutput,
  StreamingXcodeTestParser,
  XcodeTestTool,
} from "../../../src/kilocode/tool/xcode-test"
import { testEffect } from "../../lib/effect"

const ALL_PASS_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild test -workspace Keel.xcworkspace -scheme Keel -destination platform=iOS Simulator,name=iPhone 15

Test Suite 'All tests' started at 2026-07-09 10:00:00.000.
Test Suite 'KeelTests.xctest' started at 2026-07-09 10:00:00.001.
Test Suite 'LedgerStoreTests' started at 2026-07-09 10:00:00.002.
Test Case '-[LedgerStoreTests testAppendEntry]' started.
Test Case '-[LedgerStoreTests testAppendEntry]' passed (0.012 seconds).
Test Case '-[LedgerStoreTests testHashChainIntegrity]' started.
Test Case '-[LedgerStoreTests testHashChainIntegrity]' passed (0.034 seconds).
Test Case '-[LedgerStoreTests testEmptyLedgerBalance]' started.
Test Case '-[LedgerStoreTests testEmptyLedgerBalance]' passed (0.008 seconds).
Test Suite 'LedgerStoreTests' passed at 2026-07-09 10:00:00.056.
	 Executed 3 tests, with 0 failures (0 unexpected) in 0.054 (0.056) seconds
Test Suite 'KeelTests.xctest' passed at 2026-07-09 10:00:00.057.
	 Executed 3 tests, with 0 failures (0 unexpected) in 0.054 (0.057) seconds
Test Suite 'All tests' passed at 2026-07-09 10:00:00.058.
	 Executed 3 tests, with 0 failures (0 unexpected) in 0.054 (0.058) seconds

** TEST SUCCEEDED **

`

const SOME_FAIL_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild test -workspace Keel.xcworkspace -scheme Keel -destination platform=iOS Simulator,name=iPhone 15

Test Suite 'All tests' started at 2026-07-09 10:05:00.000.
Test Suite 'KeelTests.xctest' started at 2026-07-09 10:05:00.001.
Test Suite 'LedgerStoreTests' started at 2026-07-09 10:05:00.002.
Test Case '-[LedgerStoreTests testAppendEntry]' started.
Test Case '-[LedgerStoreTests testAppendEntry]' passed (0.012 seconds).
Test Case '-[LedgerStoreTests testHashChainIntegrity]' started.
/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift:58: error: -[LedgerStoreTests testHashChainIntegrity] : XCTAssertEqual failed: ("abc123") is not equal to ("def456")
Test Case '-[LedgerStoreTests testHashChainIntegrity]' failed (0.021 seconds).
Test Case '-[LedgerStoreTests testEmptyLedgerBalance]' started.
Test Case '-[LedgerStoreTests testEmptyLedgerBalance]' passed (0.008 seconds).
Test Case '-[LedgerStoreTests testNegativeAmountRejected]' started.
/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift:91: error: -[LedgerStoreTests testNegativeAmountRejected] : XCTAssertThrowsError failed: did not throw an error
Test Case '-[LedgerStoreTests testNegativeAmountRejected]' failed (0.015 seconds).
Test Suite 'LedgerStoreTests' failed at 2026-07-09 10:05:00.070.
	 Executed 4 tests, with 2 failures (0 unexpected) in 0.056 (0.070) seconds
Test Suite 'KeelTests.xctest' failed at 2026-07-09 10:05:00.071.
	 Executed 4 tests, with 2 failures (0 unexpected) in 0.056 (0.071) seconds
Test Suite 'All tests' failed at 2026-07-09 10:05:00.072.
	 Executed 4 tests, with 2 failures (0 unexpected) in 0.056 (0.072) seconds

** TEST FAILED **

`

const BUILD_FAILED_DURING_TEST_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild test -workspace Keel.xcworkspace -scheme Keel -destination platform=iOS Simulator,name=iPhone 15

CompileSwift normal arm64 /Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift
/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift:12:9: error: cannot find 'HashChain' in scope
    let chain = HashChain(seed: seed)
                ^~~~~~~~~
/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift:45:5: error: value of type 'Ledger' has no member 'appendEntry'
    ledger.appendEntry(entry)
    ^~~~~~

** BUILD FAILED **

The following build commands failed:
	CompileSwift normal arm64 /Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift
(2 failures)
`

describe("parseXcodeTestOutput", () => {
  test("all pass: ok true, status tests_passed, passed count correct, failed empty", () => {
    const result = parseXcodeTestOutput(ALL_PASS_FIXTURE, 0)

    expect(result.ok).toBe(true)
    expect(result.status).toBe("tests_passed")
    expect(result.passed).toBe(3)
    expect(result.failed).toEqual([])
    expect(result.skipped).toBe(0)
  })

  test("some fail: ok false, status tests_failed, failures carry test/file/line/message, passed count correct", () => {
    const result = parseXcodeTestOutput(SOME_FAIL_FIXTURE, 1)

    expect(result.ok).toBe(false)
    expect(result.status).toBe("tests_failed")
    expect(result.passed).toBe(2)
    expect(result.failed).toHaveLength(2)

    expect(result.failed[0]).toEqual({
      test: "LedgerStoreTests.testHashChainIntegrity",
      file: "/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift",
      line: 58,
      message: 'XCTAssertEqual failed: ("abc123") is not equal to ("def456")',
    })
    expect(result.failed[1]).toEqual({
      test: "LedgerStoreTests.testNegativeAmountRejected",
      file: "/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift",
      line: 91,
      message: "XCTAssertThrowsError failed: did not throw an error",
    })
  })

  test("build failed during test compile: status build_failed (NOT tests_failed), build errors present, no test counts", () => {
    const result = parseXcodeTestOutput(BUILD_FAILED_DURING_TEST_FIXTURE, 65)

    expect(result.ok).toBe(false)
    expect(result.status).toBe("build_failed")
    expect(result.passed).toBe(0)
    expect(result.failed).toEqual([])
    expect(result.buildErrors).toHaveLength(2)
    expect(result.buildErrors[0]).toEqual({
      file: "/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift",
      line: 12,
      column: 9,
      severity: "error",
      message: "cannot find 'HashChain' in scope",
    })
    expect(result.buildErrors[1]).toEqual({
      file: "/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift",
      line: 45,
      column: 5,
      severity: "error",
      message: "value of type 'Ledger' has no member 'appendEntry'",
    })
  })

  test("empty output does not crash and reports failure", () => {
    const result = parseXcodeTestOutput("", 1)

    expect(result.ok).toBe(false)
    expect(result.status).not.toBe("tests_passed")
    expect(result.passed).toBe(0)
    expect(result.failed).toEqual([])
  })

  test("garbage output does not crash and reports failure", () => {
    const garbage = "\x00\x01 not xcodebuild output at all \n\n\t\t random binary noise €€€ 日本語"
    const result = parseXcodeTestOutput(garbage, 1)

    expect(result.ok).toBe(false)
    expect(result.passed).toBe(0)
    expect(result.failed).toEqual([])
  })

  test("nonzero exit code wins over an all-pass log", () => {
    const result = parseXcodeTestOutput(ALL_PASS_FIXTURE, 1)
    expect(result.status).toBe("tests_passed")
    expect(result.ok).toBe(false)
  })

  test("caps failures at MAX_DIAGNOSTICS and reports truncation", () => {
    const lines: string[] = []
    const total = MAX_DIAGNOSTICS + 20
    for (let i = 0; i < total; i++) {
      lines.push(`Test Case '-[SyntheticTests test${i}]' started.`)
      lines.push(
        `/Users/dev/keel/Tests/KeelTests/SyntheticTests.swift:${i + 1}: error: -[SyntheticTests test${i}] : synthetic failure ${i}`,
      )
      lines.push(`Test Case '-[SyntheticTests test${i}]' failed (0.001 seconds).`)
    }
    lines.push(`Executed ${total} tests, with ${total} failures (0 unexpected) in 1.0 (1.0) seconds`)
    const output = lines.join("\n")

    const result = parseXcodeTestOutput(output, 1)

    expect(result.status).toBe("tests_failed")
    expect(result.failed).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.failedTruncated).toBe(true)
    expect(result.failed[0].message).toBe("synthetic failure 0")
  })
})

describe("buildTestArgs", () => {
  test("includes only the flags that were provided", () => {
    const args = buildTestArgs({})
    expect(args).toEqual(["test"])
  })

  test("includes workspace, scheme, destination, and -only-testing: from testFilter", () => {
    const args = buildTestArgs({
      workspace: "Keel.xcworkspace",
      scheme: "Keel",
      destination: "platform=iOS Simulator,name=iPhone 15",
      testFilter: "KeelTests/LedgerStoreTests/testAppendEntry",
    })
    expect(args).toEqual([
      "test",
      "-workspace",
      "Keel.xcworkspace",
      "-scheme",
      "Keel",
      "-destination",
      "platform=iOS Simulator,name=iPhone 15",
      "-only-testing:KeelTests/LedgerStoreTests/testAppendEntry",
    ])
  })

  test("includes project instead of workspace when project is given", () => {
    const args = buildTestArgs({ project: "Keel.xcodeproj", scheme: "Keel" })
    expect(args).toEqual(["test", "-project", "Keel.xcodeproj", "-scheme", "Keel"])
  })

  test("appends extraArgs verbatim at the end", () => {
    const args = buildTestArgs({ scheme: "Keel", extraArgs: ["-quiet", "CODE_SIGNING_ALLOWED=NO"] })
    expect(args).toEqual(["test", "-scheme", "Keel", "-quiet", "CODE_SIGNING_ALLOWED=NO"])
  })
})

describe("StreamingXcodeTestParser (bounded memory, no result lost)", () => {
  test("parses results fed as arbitrarily-split chunks, not aligned to line boundaries", () => {
    const parser = new StreamingXcodeTestParser()
    // Split the some-fail fixture into 7-byte chunks so newlines (and the failure detail line)
    // land mid-chunk.
    for (let i = 0; i < SOME_FAIL_FIXTURE.length; i += 7) {
      parser.push(SOME_FAIL_FIXTURE.slice(i, i + 7))
    }
    parser.finish()
    const result = parser.result(1)
    expect(result.status).toBe("tests_failed")
    expect(result.ok).toBe(false)
    expect(result.passed).toBe(2)
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]).toEqual({
      test: "LedgerStoreTests.testHashChainIntegrity",
      file: "/Users/dev/keel/Tests/KeelTests/LedgerStoreTests.swift",
      line: 58,
      message: 'XCTAssertEqual failed: ("abc123") is not equal to ("def456")',
    })
    expect(result.failed[1].test).toBe("LedgerStoreTests.testNegativeAmountRejected")
  })

  test("streaming result matches the pure parser for the same output (all-pass)", () => {
    const parser = new StreamingXcodeTestParser()
    parser.push(ALL_PASS_FIXTURE)
    parser.finish()
    expect(parser.result(0)).toMatchObject({
      ok: true,
      status: "tests_passed",
      passed: 3,
      failed: [],
    })
  })

  test("streaming build-failed-during-test matches the pure parser", () => {
    const parser = new StreamingXcodeTestParser()
    parser.push(BUILD_FAILED_DURING_TEST_FIXTURE)
    parser.finish()
    const result = parser.result(65)
    expect(result.status).toBe("build_failed")
    expect(result.ok).toBe(false)
    expect(result.buildErrors).toHaveLength(2)
  })

  test("BOUNDED MEMORY: 5MB of noise with a late failure — failure captured, retained tail stays under the cap", () => {
    const parser = new StreamingXcodeTestParser()
    const noiseLine = "note: running test with many many fixtures ".padEnd(100, "x") + "\n"
    const oneMB = 1024 * 1024
    let pushed = 0
    while (pushed < oneMB) {
      parser.push(noiseLine)
      pushed += noiseLine.length
    }
    parser.push("Test Case '-[LateTests testNeedle]' started.\n")
    parser.push(
      "/Users/dev/keel/Tests/KeelTests/LateTests.swift:999: error: -[LateTests testNeedle] : needle in the haystack\n",
    )
    parser.push("Test Case '-[LateTests testNeedle]' failed (0.5 seconds).\n")
    pushed = 0
    while (pushed < 4 * oneMB) {
      parser.push(noiseLine)
      pushed += noiseLine.length
    }
    parser.push("Executed 1 test, with 1 failures (0 unexpected) in 0.5 (0.5) seconds\n")
    parser.finish()

    const result = parser.result(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toEqual({
      test: "LateTests.testNeedle",
      file: "/Users/dev/keel/Tests/KeelTests/LateTests.swift",
      line: 999,
      message: "needle in the haystack",
    })
    expect(result.status).toBe("tests_failed")
    const tailBytes = Buffer.byteLength(parser.retainedTail(), "utf-8")
    expect(tailBytes).toBeLessThanOrEqual(MAX_RETAINED_TAIL_BYTES)
    expect(parser.tailTruncated()).toBe(true)
  })

  test("small output is not marked tail-truncated and is retained in full", () => {
    const parser = new StreamingXcodeTestParser()
    parser.push(SOME_FAIL_FIXTURE)
    parser.finish()
    expect(parser.tailTruncated()).toBe(false)
    expect(parser.retainedTail()).toBe(SOME_FAIL_FIXTURE)
  })

  test("caps failures at MAX_DIAGNOSTICS while streaming (bounded arrays)", () => {
    const parser = new StreamingXcodeTestParser()
    for (let i = 0; i < MAX_DIAGNOSTICS + 15; i++) {
      parser.push(`Test Case '-[SyntheticTests test${i}]' started.\n`)
      parser.push(
        `/Users/dev/keel/Tests/KeelTests/SyntheticTests.swift:${i + 1}: error: -[SyntheticTests test${i}] : synthetic ${i}\n`,
      )
      parser.push(`Test Case '-[SyntheticTests test${i}]' failed (0.001 seconds).\n`)
    }
    parser.push(`Executed ${MAX_DIAGNOSTICS + 15} tests, with ${MAX_DIAGNOSTICS + 15} failures (0 unexpected) in 1.0 (1.0) seconds\n`)
    parser.finish()
    const result = parser.result(1)
    expect(result.failed).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.failedTruncated).toBe(true)
    expect(result.failed[0].message).toBe("synthetic 0")
  })
})

// ---- Effect-harness tests for the execute path: spawn failure vs build failure vs test failure ----

const encoder = new TextEncoder()

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

const runExecute = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Effect.gen(function* () {
    const info = yield* XcodeTestTool
    const tool = yield* info.init()
    return yield* tool.execute({ scheme: "Keel" }, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("XcodeTestTool execute: spawn failure vs build failure vs test outcomes", () => {
  harness.instance("spawn failure yields status:spawn_failed with the message, NOT phantom test counts", () =>
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
      expect(summary.passed).toBeUndefined()
      expect(summary.failed).toBeUndefined()
      expect(result.metadata.status).toBe("spawn_failed")
      expect(result.metadata.error).toContain("xcodebuild")
    }),
  )

  harness.instance("a build failure during test compile yields status:build_failed with build diagnostics and a raw log", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(BUILD_FAILED_DURING_TEST_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 65)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("build_failed")
      expect(summary.ok).toBe(false)
      expect(summary.buildErrors).toHaveLength(2)
      expect(typeof summary.rawLogPath).toBe("string")
    }),
  )

  harness.instance("a test failure yields status:tests_failed with parsed failures and a raw log", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(SOME_FAIL_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 1)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("tests_failed")
      expect(summary.ok).toBe(false)
      expect(summary.passed).toBe(2)
      expect(summary.failed).toHaveLength(2)
      expect(typeof summary.rawLogPath).toBe("string")
    }),
  )

  harness.instance("an all-passing run writes a raw log (results present) and reports tests_passed", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(ALL_PASS_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("tests_passed")
      expect(summary.ok).toBe(true)
      expect(summary.passed).toBe(3)
      expect(summary.failed).toEqual([])
    }),
  )

  harness.instance("a run with no output at all leaves no rawLogPath", () =>
    Effect.gen(function* () {
      const all = Stream.empty
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.rawLogPath).toBeUndefined()
    }),
  )
})
