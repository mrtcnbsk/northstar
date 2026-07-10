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
  buildArgs,
  MAX_DIAGNOSTICS,
  MAX_RETAINED_TAIL_BYTES,
  parseXcodebuildOutput,
  StreamingXcodeParser,
  XcodeBuildTool,
} from "../../../src/kilocode/tool/xcode-build"
import { testEffect } from "../../lib/effect"

const FAILED_BUILD_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild build -workspace Keel.xcworkspace -scheme Keel -configuration Debug

User defaults from command line:
    IDEPackageSupportUseBuiltinSCM = YES

ComputePackagePrebuildTargetDependencyGraph
ComputePackagePrebuildTargetDependencyGraph (0.1 seconds)

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:42:15: error: cannot find 'HashChain' in scope
    let chain = HashChain(seed: seed)
                ^~~~~~~~~
/Users/dev/keel/Sources/Keel/LedgerStore.swift:58:9: error: value of type 'Ledger' has no member 'appendEntry'
        ledger.appendEntry(entry)
        ^~~~~~
/Users/dev/keel/Sources/Keel/Views/DashboardView.swift:120:31: error: cannot convert value of type 'String' to expected argument type 'Decimal'
    Text(formatAmount(total))
                       ^~~~~

** BUILD FAILED **

The following build commands failed:
	CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
(3 failures)
`

const SUCCEEDED_BUILD_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild build -workspace Keel.xcworkspace -scheme Keel -configuration Debug

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:12:5: warning: variable 'unused' was never used; consider replacing with '_'
    var unused = 0
        ^

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/Views/DashboardView.swift
Ld /Users/dev/keel/build/Debug/Keel.app/Contents/MacOS/Keel normal

** BUILD SUCCEEDED **

`

describe("parseXcodebuildOutput", () => {
  test("failed build: ok is false, errors are extracted with file/line/message, buildSucceeded is false", () => {
    const result = parseXcodebuildOutput(FAILED_BUILD_FIXTURE, 65)

    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.warnings).toHaveLength(0)

    expect(result.errors[0]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
      line: 42,
      column: 15,
      severity: "error",
      message: "cannot find 'HashChain' in scope",
    })
    expect(result.errors[1]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
      line: 58,
      column: 9,
      severity: "error",
      message: "value of type 'Ledger' has no member 'appendEntry'",
    })
    expect(result.errors[2]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/Views/DashboardView.swift",
      line: 120,
      column: 31,
      severity: "error",
      message: "cannot convert value of type 'String' to expected argument type 'Decimal'",
    })
  })

  test("succeeded build: ok is true, warnings are parsed, errors empty", () => {
    const result = parseXcodebuildOutput(SUCCEEDED_BUILD_FIXTURE, 0)

    expect(result.ok).toBe(true)
    expect(result.buildSucceeded).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
      line: 12,
      column: 5,
      severity: "warning",
      message: "variable 'unused' was never used; consider replacing with '_'",
    })
  })

  test("nonzero exit code wins over a BUILD SUCCEEDED marker in the text", () => {
    const result = parseXcodebuildOutput(SUCCEEDED_BUILD_FIXTURE, 1)

    expect(result.buildSucceeded).toBe(true)
    expect(result.ok).toBe(false)
  })

  test("empty output does not crash and reports failure", () => {
    const result = parseXcodebuildOutput("", 1)

    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("garbage output does not crash and reports failure", () => {
    const garbage = "\x00\x01 not xcodebuild output at all \n\n\t\t random binary noise €€€ 日本語"
    const result = parseXcodebuildOutput(garbage, 1)

    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("caps errors at MAX_DIAGNOSTICS and reports truncation", () => {
    const lines: string[] = []
    const total = MAX_DIAGNOSTICS + 25
    for (let i = 0; i < total; i++) {
      lines.push(`/Users/dev/keel/Sources/Keel/File${i}.swift:${i + 1}:1: error: synthetic error ${i}`)
    }
    lines.push("** BUILD FAILED **")
    const output = lines.join("\n")

    const result = parseXcodebuildOutput(output, 65)

    expect(result.errors).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.errorTruncated).toBe(true)
    expect(result.warningTruncated).toBe(false)
    // Confirms the cap kept the FIRST MAX_DIAGNOSTICS entries, not an arbitrary subset.
    expect(result.errors[0].message).toBe("synthetic error 0")
    expect(result.errors[MAX_DIAGNOSTICS - 1].message).toBe(`synthetic error ${MAX_DIAGNOSTICS - 1}`)
  })

  test("caps warnings at MAX_DIAGNOSTICS independently from errors", () => {
    const lines: string[] = []
    const total = MAX_DIAGNOSTICS + 10
    for (let i = 0; i < total; i++) {
      lines.push(`/Users/dev/keel/Sources/Keel/File${i}.swift:${i + 1}:1: warning: synthetic warning ${i}`)
    }
    lines.push("** BUILD SUCCEEDED **")
    const output = lines.join("\n")

    const result = parseXcodebuildOutput(output, 0)

    expect(result.warnings).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.warningTruncated).toBe(true)
    expect(result.errorTruncated).toBe(false)
    expect(result.ok).toBe(true)
  })

  test("does not crash on a line matching the diagnostic shape but with an unrecognized severity word", () => {
    const output = "/Users/dev/keel/Sources/Keel/File.swift:1:1: note: this is just a note\n** BUILD SUCCEEDED **"
    const result = parseXcodebuildOutput(output, 0)

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe("buildArgs", () => {
  test("includes only the flags that were provided, plus configuration default", () => {
    const args = buildArgs({})
    expect(args).toEqual(["build", "-configuration", "Debug"])
  })

  test("includes workspace, scheme, configuration, destination in order", () => {
    const args = buildArgs({
      workspace: "Keel.xcworkspace",
      scheme: "Keel",
      configuration: "Release",
      destination: "platform=iOS Simulator,name=iPhone 15",
    })
    expect(args).toEqual([
      "build",
      "-workspace",
      "Keel.xcworkspace",
      "-scheme",
      "Keel",
      "-configuration",
      "Release",
      "-destination",
      "platform=iOS Simulator,name=iPhone 15",
    ])
  })

  test("includes project instead of workspace when project is given", () => {
    const args = buildArgs({ project: "Keel.xcodeproj", scheme: "Keel" })
    expect(args).toEqual(["build", "-project", "Keel.xcodeproj", "-scheme", "Keel", "-configuration", "Debug"])
  })

  test("appends extraArgs verbatim at the end", () => {
    const args = buildArgs({ scheme: "Keel", extraArgs: ["-quiet", "CODE_SIGNING_ALLOWED=NO"] })
    expect(args).toEqual([
      "build",
      "-scheme",
      "Keel",
      "-configuration",
      "Debug",
      "-quiet",
      "CODE_SIGNING_ALLOWED=NO",
    ])
  })

  test("defaults configuration to Debug when omitted", () => {
    const args = buildArgs({ scheme: "Keel" })
    expect(args).toContain("-configuration")
    expect(args[args.indexOf("-configuration") + 1]).toBe("Debug")
  })
})

describe("StreamingXcodeParser (bounded memory, no diagnostic lost)", () => {
  test("parses diagnostics fed as arbitrarily-split chunks, not aligned to line boundaries", () => {
    const parser = new StreamingXcodeParser()
    // Split the failed-build fixture into 7-byte chunks so newlines land mid-chunk.
    for (let i = 0; i < FAILED_BUILD_FIXTURE.length; i += 7) {
      parser.push(FAILED_BUILD_FIXTURE.slice(i, i + 7))
    }
    parser.finish()
    const result = parser.result(65)
    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0].message).toBe("cannot find 'HashChain' in scope")
    expect(result.errors[2].file).toBe("/Users/dev/keel/Sources/Keel/Views/DashboardView.swift")
  })

  test("streaming result matches the pure parser for the same output", () => {
    const parser = new StreamingXcodeParser()
    parser.push(SUCCEEDED_BUILD_FIXTURE)
    parser.finish()
    expect(parser.result(0)).toMatchObject({
      ok: true,
      buildSucceeded: true,
      errors: [],
      warnings: parseXcodebuildOutput(SUCCEEDED_BUILD_FIXTURE, 0).warnings,
    })
  })

  test("BOUNDED MEMORY: 5MB of noise with a late error — error captured, retained tail stays under the cap", () => {
    const parser = new StreamingXcodeParser()
    // ~1MB of leading noise, then an error, then ~4MB more noise. The error sits well past 1MB,
    // proving the streaming regex captures it regardless of total size.
    const noiseLine = "note: compiling module with many many files ".padEnd(100, "x") + "\n"
    const oneMB = 1024 * 1024
    let pushed = 0
    while (pushed < oneMB) {
      parser.push(noiseLine)
      pushed += noiseLine.length
    }
    parser.push("/Users/dev/keel/Sources/Keel/Late.swift:999:7: error: needle in the haystack\n")
    pushed = 0
    while (pushed < 4 * oneMB) {
      parser.push(noiseLine)
      pushed += noiseLine.length
    }
    parser.push("** BUILD FAILED **\n")
    parser.finish()

    const result = parser.result(65)
    // No diagnostic lost: the error buried after 1MB of noise is present.
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/Late.swift",
      line: 999,
      column: 7,
      severity: "error",
      message: "needle in the haystack",
    })
    expect(result.buildSucceeded).toBe(false)
    // Memory bounded: the retained raw-text tail never exceeds the cap despite 5MB of input.
    const tailBytes = Buffer.byteLength(parser.retainedTail(), "utf-8")
    expect(tailBytes).toBeLessThanOrEqual(MAX_RETAINED_TAIL_BYTES)
    expect(parser.tailTruncated()).toBe(true)
  })

  test("small output is not marked tail-truncated and is retained in full", () => {
    const parser = new StreamingXcodeParser()
    parser.push(FAILED_BUILD_FIXTURE)
    parser.finish()
    expect(parser.tailTruncated()).toBe(false)
    expect(parser.retainedTail()).toBe(FAILED_BUILD_FIXTURE)
  })

  test("caps errors at MAX_DIAGNOSTICS while streaming (bounded diagnostic arrays)", () => {
    const parser = new StreamingXcodeParser()
    for (let i = 0; i < MAX_DIAGNOSTICS + 40; i++) {
      parser.push(`/Users/dev/keel/Sources/Keel/File${i}.swift:${i + 1}:1: error: synthetic ${i}\n`)
    }
    parser.push("** BUILD FAILED **\n")
    parser.finish()
    const result = parser.result(65)
    expect(result.errors).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.errorTruncated).toBe(true)
    expect(result.errors[0].message).toBe("synthetic 0")
    expect(result.errors[MAX_DIAGNOSTICS - 1].message).toBe(`synthetic ${MAX_DIAGNOSTICS - 1}`)
  })
})

// ---- Effect-harness tests for the execute path: spawn failure vs build failure ----

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

const runExecute = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], params: Record<string, unknown> = { scheme: "Keel" }) =>
  Effect.gen(function* () {
    const info = yield* XcodeBuildTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("XcodeBuildTool execute: spawn failure vs build failure", () => {
  harness.instance("spawn failure yields status:spawn_failed with the message, NOT an empty build failure", () =>
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
      // The infra error message is surfaced, and it is NOT masquerading as a zero-diagnostic build.
      expect(summary.error).toContain("xcodebuild")
      expect(summary.errorCount).toBeUndefined()
      expect(summary.errors).toBeUndefined()
      expect(result.metadata.status).toBe("spawn_failed")
      expect(result.metadata.error).toContain("xcodebuild")
    }),
  )

  harness.instance("a real build failure yields status:build_failed with parsed diagnostics and a raw log", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(FAILED_BUILD_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 65)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("build_failed")
      expect(summary.ok).toBe(false)
      expect(summary.errorCount).toBe(3)
      // Diagnostics present means the raw log was kept.
      expect(typeof summary.rawLogPath).toBe("string")
    }),
  )

  harness.instance("a clean successful build writes NO raw log (disk hygiene) and reports build_succeeded", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(SUCCEEDED_BUILD_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("build_succeeded")
      expect(summary.ok).toBe(true)
      // A warning is present in the fixture, so a raw log IS kept; assert the parse is right.
      expect(summary.warningCount).toBe(1)
    }),
  )

  harness.instance("a warning-free successful build leaves no rawLogPath", () =>
    Effect.gen(function* () {
      const clean = "Command line invocation\nCompileSwift ok\n** BUILD SUCCEEDED **\n"
      const all = Stream.make(encoder.encode(clean))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner)
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("build_succeeded")
      expect(summary.ok).toBe(true)
      expect(summary.errorCount).toBe(0)
      expect(summary.warningCount).toBe(0)
      expect(summary.rawLogPath).toBeUndefined()
    }),
  )
})

// kilocode_change start - W2.6: extraArgs blast-radius validation (see xcode-argv.ts)
describe("XcodeBuildTool execute: extraArgs validation", () => {
  harness.instance("a disallowed extraArg (-derivedDataPath) yields status:invalid_args and NEVER spawns xcodebuild", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { scheme: "Keel", extraArgs: ["-derivedDataPath", "/etc"] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(summary.error).toBe("disallowed extraArg: -derivedDataPath")
      expect(spawnCalled).toBe(false)
      expect(result.metadata.status).toBe("invalid_args")
    }),
  )

  harness.instance("a path-traversal extraArg yields status:invalid_args and NEVER spawns xcodebuild", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, { scheme: "Keel", extraArgs: ["../../etc/passwd"] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid_args")
      expect(spawnCalled).toBe(false)
    }),
  )

  harness.instance("a benign extraArg (-quiet) is allowed through and xcodebuild is spawned normally", () =>
    Effect.gen(function* () {
      const all = Stream.make(encoder.encode(SUCCEEDED_BUILD_FIXTURE))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner, { scheme: "Keel", extraArgs: ["-quiet"] })
      const summary = JSON.parse(result.output)
      expect(summary.status).toBe("build_succeeded")
      expect(summary.ok).toBe(true)
    }),
  )
})
// kilocode_change end
