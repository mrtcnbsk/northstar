// kilocode_change - new file
import { Effect, Schema, Stream } from "effect"
import { createWriteStream } from "node:fs"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "@/tool/truncate"
import { validateExtraArgs } from "./xcode-argv"
import DESCRIPTION from "./xcode-test.txt"

// Test runs can legitimately run long (large suites, UI tests, simulator boot time). 10 minutes
// mirrors xcode_build's budget: generous enough to avoid false timeouts while still bounding a
// single test attempt inside a build-loop budget.
export const TEST_TIMEOUT_MS = 10 * 60 * 1000

// Bound the number of parsed failures/build-diagnostics returned to the model. xcodebuild can
// emit thousands of lines; the raw log (rawLogPath) remains available for full detail.
export const MAX_DIAGNOSTICS = 100

// Cap the raw-output tail retained in memory, mirroring xcode_build's rationale: xcodebuild test
// logs run to thousands of lines, so only a bounded trailing slice is retained for the
// human-facing preview while every complete line is parsed as it arrives (no result is ever
// dropped no matter how large the total output). The full log, when kept, is streamed to disk.
export const MAX_RETAINED_TAIL_BYTES = 256 * 1024

export const Params = Schema.Struct({
  scheme: Schema.optional(Schema.String).annotate({ description: "Xcode scheme to test" }),
  workspace: Schema.optional(Schema.String).annotate({ description: "Path to an .xcworkspace" }),
  project: Schema.optional(Schema.String).annotate({ description: "Path to an .xcodeproj" }),
  destination: Schema.optional(Schema.String).annotate({
    description: "xcodebuild destination specifier, e.g. 'platform=iOS Simulator,name=iPhone 15'",
  }),
  testFilter: Schema.optional(Schema.String).annotate({
    description:
      "Restrict the run to one test/class/suite via -only-testing:, e.g. 'KeelTests/LedgerStoreTests/testAppend'",
  }),
  extraArgs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional raw arguments appended to the xcodebuild invocation",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type BuildDiagnostic = {
  file: string
  line: number
  column: number
  severity: "error" | "warning"
  message: string
}

export type TestFailure = {
  test: string
  file?: string
  line?: number
  message?: string
}

export type ParsedTest = {
  ok: boolean
  status: "build_failed" | "tests_failed" | "tests_passed"
  passed: number
  failed: TestFailure[]
  skipped: number
  failedTruncated: boolean
  // Populated only when status is "build_failed" — the test build never ran, so no
  // Test Case results exist at all; reuses the build-diagnostic parse for that case.
  buildErrors: BuildDiagnostic[]
  buildWarnings: BuildDiagnostic[]
}

// Shared metadata shape across every execute() return path (invalid args, spawn failure, build/test
// outcome) — Tool.define infers execute()'s return type from its first `return`, so every branch
// must satisfy one common type rather than each narrowing independently.
export type XcodeTestMeta = {
  ok: boolean
  status: "invalid_args" | "spawn_failed" | "build_failed" | "tests_failed" | "tests_passed"
  error?: string
  passed?: number
  failedCount?: number
  rawLogPath?: string
  durationMs?: number
}

const BUILD_DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+): (error|warning): (.+)$/

// `Test Case '-[SuiteName testName]' passed (0.501 seconds).`
// `Test Case '-[SuiteName testName]' failed (0.031 seconds).`
const TEST_CASE_RE = /^Test Case '-\[(\S+) (\S+)\]' (passed|failed) \(([\d.]+) seconds\)\.$/

// `/path/to/File.swift:42: error: -[SuiteName testName] : XCTAssertEqual failed: ("1") is not equal to ("2")`
const TEST_FAILURE_DETAIL_RE = /^(.+?):(\d+): error: -\[(\S+) (\S+)\] : (.*)$/

// `Executed 5 tests, with 2 failures (0 unexpected) in 1.234 (1.245) seconds`
const EXECUTED_SUMMARY_RE = /^\s*Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\)/

/** Build the xcodebuild argv from tool params. Only includes flags that were provided. */
export function buildTestArgs(params: Params): string[] {
  const args = ["test"]
  if (params.workspace) args.push("-workspace", params.workspace)
  if (params.project) args.push("-project", params.project)
  if (params.scheme) args.push("-scheme", params.scheme)
  if (params.destination) args.push("-destination", params.destination)
  if (params.testFilter) args.push(`-only-testing:${params.testFilter}`)
  if (params.extraArgs) args.push(...params.extraArgs)
  return args
}

/**
 * Pure parser: turns raw `xcodebuild test` stdout/stderr text + process exit code into a
 * structured result. No I/O, no Effect — safe to unit test with captured fixtures.
 *
 * Distinguishes a BUILD FAILURE during the test build (compile errors before any test ran) from
 * actual test failures: if no `Test Case ... passed|failed` line was ever seen AND the log
 * contains `** BUILD FAILED **`, status is "build_failed" and the build-diagnostic regex (same
 * `file:line:col: severity: message` shape as xcode_build) is used to extract errors/warnings.
 * Otherwise, status reflects the XCTest results themselves.
 *
 * `ok` requires BOTH a zero exit code AND status === "tests_passed"; a nonzero exit code or any
 * build/test failure marker means failure even if some other signal looks clean.
 */
export function parseXcodeTestOutput(output: string, exitCode: number): ParsedTest {
  const text = output ?? ""
  const lines = text.split(/\r?\n/)

  let sawTestCase = false
  let executedTotal: number | undefined
  let executedFailures: number | undefined
  const failed: TestFailure[] = []
  let failedTruncated = false
  const failureDetailByTest = new Map<string, { file: string; line: number; message: string }>()
  let passedCount = 0

  for (const raw of lines) {
    const line = raw.trim()

    const detail = TEST_FAILURE_DETAIL_RE.exec(line)
    if (detail) {
      const [, file, lineNo, suite, test, message] = detail
      failureDetailByTest.set(`${suite} ${test}`, { file, line: Number(lineNo), message })
      continue
    }

    const testCase = TEST_CASE_RE.exec(line)
    if (testCase) {
      sawTestCase = true
      const [, suite, test, result] = testCase
      if (result === "passed") {
        passedCount++
      } else {
        const key = `${suite} ${test}`
        const found = failureDetailByTest.get(key)
        const entry: TestFailure = {
          test: `${suite}.${test}`,
          ...(found ? { file: found.file, line: found.line, message: found.message } : {}),
        }
        if (failed.length < MAX_DIAGNOSTICS) failed.push(entry)
        else failedTruncated = true
      }
      continue
    }

    const summary = EXECUTED_SUMMARY_RE.exec(line)
    if (summary) {
      executedTotal = Number(summary[1])
      executedFailures = Number(summary[2])
    }
  }

  const buildFailed = text.includes("** BUILD FAILED **") && !sawTestCase
  if (buildFailed) {
    const buildErrors: BuildDiagnostic[] = []
    const buildWarnings: BuildDiagnostic[] = []
    for (const raw of lines) {
      const match = BUILD_DIAGNOSTIC_RE.exec(raw.trim())
      if (!match) continue
      const [, file, lineNo, col, severity, message] = match
      const d: BuildDiagnostic = { file, line: Number(lineNo), column: Number(col), severity: severity as any, message }
      if (severity === "error") {
        if (buildErrors.length < MAX_DIAGNOSTICS) buildErrors.push(d)
      } else {
        if (buildWarnings.length < MAX_DIAGNOSTICS) buildWarnings.push(d)
      }
    }
    return {
      ok: false,
      status: "build_failed",
      passed: 0,
      failed: [],
      skipped: 0,
      failedTruncated: false,
      buildErrors,
      buildWarnings,
    }
  }

  // Prefer the "Executed N tests, with M failures" summary line for counts when present (it's
  // xcodebuild's own authoritative tally), falling back to what we counted from Test Case lines
  // if the summary is missing (e.g. a crash mid-run, or truncated output).
  const passed = executedTotal !== undefined && executedFailures !== undefined ? executedTotal - executedFailures : passedCount
  const failCount = executedFailures ?? failed.length
  // No Test Case line and no "Executed N tests" summary means we have no positive evidence any
  // test ran at all (empty/garbage output, or a crash before the first result) — never report
  // "tests_passed" on the absence of a signal, mirroring xcode_build's rule that an empty log
  // never counts as BUILD SUCCEEDED.
  const noSignal = !sawTestCase && executedTotal === undefined
  const status = noSignal || failCount > 0 ? ("tests_failed" as const) : ("tests_passed" as const)

  return {
    ok: exitCode === 0 && status === "tests_passed" && !noSignal,
    status,
    passed: Math.max(0, passed),
    failed,
    skipped: 0,
    failedTruncated,
    buildErrors: [],
    buildWarnings: [],
  }
}

/**
 * Streaming, line-buffered `xcodebuild test` parser with bounded memory. Mirrors
 * `StreamingXcodeParser` from xcode-build.ts: line-buffered so chunk boundaries never split a
 * regex match, a bounded tail (MAX_RETAINED_TAIL_BYTES) for the human-facing preview, and
 * diagnostics/failures stored in arrays independent of the tail so nothing is ever lost to
 * trimming. See xcode-test.ts's reuse note: this is a deliberate structural copy rather than a
 * shared import, because build-vs-test state tracking is not identical (see parseXcodeTestOutput
 * doc comment for the distinction this class also implements incrementally).
 */
export class StreamingXcodeTestParser {
  private pending = ""
  private tail = ""
  private tailBytes = 0
  private everTrimmed = false
  private sawTestCase = false
  private sawBuildFailed = false
  private executedTotal: number | undefined
  private executedFailures: number | undefined
  private passedCount = 0
  private readonly failed: TestFailure[] = []
  private failedTruncated = false
  private readonly failureDetailByTest = new Map<string, { file: string; line: number; message: string }>()
  private readonly buildErrors: BuildDiagnostic[] = []
  private readonly buildWarnings: BuildDiagnostic[] = []

  constructor(private readonly maxTailBytes: number = MAX_RETAINED_TAIL_BYTES) {}

  push(chunk: string): void {
    if (!chunk) return
    this.retainTail(chunk)
    this.pending += chunk
    let nl = this.pending.indexOf("\n")
    while (nl !== -1) {
      this.consumeLine(this.pending.slice(0, nl))
      this.pending = this.pending.slice(nl + 1)
      nl = this.pending.indexOf("\n")
    }
  }

  finish(): void {
    if (this.pending.length > 0) {
      this.consumeLine(this.pending)
      this.pending = ""
    }
  }

  private consumeLine(raw: string): void {
    const line = raw.trim()
    if (line.includes("** BUILD FAILED **")) this.sawBuildFailed = true

    // Always track build-diagnostic-shaped lines (cheap regex), since we only know in
    // hindsight (at result() time, once we know whether any Test Case ever ran) whether this
    // was a build failure. Independent MAX_DIAGNOSTICS caps mirror xcode_build.
    const buildMatch = BUILD_DIAGNOSTIC_RE.exec(line)
    if (buildMatch) {
      const [, file, lineNo, col, severity, message] = buildMatch
      const d: BuildDiagnostic = { file, line: Number(lineNo), column: Number(col), severity: severity as any, message }
      if (severity === "error") {
        if (this.buildErrors.length < MAX_DIAGNOSTICS) this.buildErrors.push(d)
      } else {
        if (this.buildWarnings.length < MAX_DIAGNOSTICS) this.buildWarnings.push(d)
      }
    }

    const detail = TEST_FAILURE_DETAIL_RE.exec(line)
    if (detail) {
      const [, file, lineNo, suite, test, message] = detail
      this.failureDetailByTest.set(`${suite} ${test}`, { file, line: Number(lineNo), message })
      return
    }

    const testCase = TEST_CASE_RE.exec(line)
    if (testCase) {
      this.sawTestCase = true
      const [, suite, test, result] = testCase
      if (result === "passed") {
        this.passedCount++
      } else {
        const key = `${suite} ${test}`
        const found = this.failureDetailByTest.get(key)
        const entry: TestFailure = {
          test: `${suite}.${test}`,
          ...(found ? { file: found.file, line: found.line, message: found.message } : {}),
        }
        if (this.failed.length < MAX_DIAGNOSTICS) this.failed.push(entry)
        else this.failedTruncated = true
      }
      return
    }

    const summary = EXECUTED_SUMMARY_RE.exec(line)
    if (summary) {
      this.executedTotal = Number(summary[1])
      this.executedFailures = Number(summary[2])
    }
  }

  private retainTail(chunk: string): void {
    this.tail += chunk
    this.tailBytes += Buffer.byteLength(chunk, "utf-8")
    if (this.tailBytes <= this.maxTailBytes) return
    const overshoot = this.tailBytes - this.maxTailBytes
    this.tail = this.tail.slice(Math.min(overshoot, this.tail.length))
    this.tailBytes = Buffer.byteLength(this.tail, "utf-8")
    this.everTrimmed = true
  }

  retainedTail(): string {
    return this.tail
  }

  tailTruncated(): boolean {
    return this.everTrimmed
  }

  /** Cheap check (no allocation) for whether any result has been captured yet — used to decide
   * whether the raw log is worth spilling to disk. */
  hasResults(): boolean {
    return this.sawTestCase || this.buildErrors.length > 0 || this.buildWarnings.length > 0
  }

  result(exitCode: number): ParsedTest {
    const buildFailed = this.sawBuildFailed && !this.sawTestCase
    if (buildFailed) {
      return {
        ok: false,
        status: "build_failed",
        passed: 0,
        failed: [],
        skipped: 0,
        failedTruncated: false,
        buildErrors: this.buildErrors,
        buildWarnings: this.buildWarnings,
      }
    }

    const passed =
      this.executedTotal !== undefined && this.executedFailures !== undefined
        ? this.executedTotal - this.executedFailures
        : this.passedCount
    const failCount = this.executedFailures ?? this.failed.length
    // See parseXcodeTestOutput's doc comment: no Test Case line and no "Executed N tests"
    // summary means there is no positive evidence any test ran, so never claim tests_passed.
    const noSignal = !this.sawTestCase && this.executedTotal === undefined
    const status = noSignal || failCount > 0 ? ("tests_failed" as const) : ("tests_passed" as const)

    return {
      ok: exitCode === 0 && status === "tests_passed" && !noSignal,
      status,
      passed: Math.max(0, passed),
      failed: this.failed,
      skipped: 0,
      failedTruncated: this.failedTruncated,
      buildErrors: [],
      buildWarnings: [],
    }
  }
}

export const XcodeTestTool = Tool.define(
  "xcode_test",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cwd = instance.directory
          const args = buildTestArgs(params)

          // Reject path-escaping/blast-radius-widening extraArgs BEFORE prompting for permission
          // or spawning xcodebuild: this is a hard input-validation failure, not something a
          // permission grant should be able to bless. See xcode-argv.ts for the denylist rationale.
          const argvError = validateExtraArgs(params.extraArgs)
          if (argvError) {
            const title = params.scheme ? `xcodebuild test: ${params.scheme}` : "xcodebuild test"
            const metadata: XcodeTestMeta = { ok: false, status: "invalid_args", error: argvError }
            return { title, output: JSON.stringify(metadata), metadata }
          }

          yield* ctx.ask({
            permission: "xcode_test",
            patterns: [params.scheme ?? "*"],
            always: [params.scheme ?? "*"],
            metadata: { scheme: params.scheme, workspace: params.workspace, project: params.project },
          })

          const start = Date.now()
          const command = ChildProcess.make("xcodebuild", args, { cwd, stdin: "ignore" })

          // Same architecture as xcode_build: run the process, drain output through the bounded
          // streaming parser, and lazily spill the full log to disk only once it's worth keeping
          // (a result or a build failure appeared) — a clean, fully-passing run leaves no raw log.
          type Ran = {
            kind: "ran"
            parser: StreamingXcodeTestParser
            exitCode: number
            rawLogPath?: string
            rawLogNote?: string
          }
          type SpawnFailed = { kind: "spawn_failed"; error: string }

          const run = Effect.scoped(
            Effect.gen(function* () {
              // Spawn is caught SEPARATELY below so a toolchain/spawn failure (xcodebuild missing,
              // bad cwd, PlatformError) is not masked as a test run that "failed" with zero results.
              const handle = yield* spawner.spawn(command)
              const parser = new StreamingXcodeTestParser()

              let sink: ReturnType<typeof createWriteStream> | undefined
              let rawLogPath: string | undefined
              let rawLogNote: string | undefined

              const openSink = Effect.fnUntraced(function* () {
                if (sink || rawLogNote) return
                const path = yield* trunc.write("")
                rawLogPath = path
                sink = createWriteStream(path, { flags: "a" })
                sink.on("error", () => {
                  rawLogNote = "raw log write failed (disk full or permission denied); results above are complete"
                  sink = undefined
                })
                try {
                  sink.write(parser.retainedTail())
                } catch {
                  /* covered by the sink error handler above */
                }
              })

              const drain = Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  parser.push(chunk)
                  if (!sink && !rawLogNote && parser.hasResults()) {
                    yield* openSink()
                  }
                  if (sink) {
                    try {
                      sink.write(chunk)
                    } catch {
                      /* covered by the sink error handler */
                    }
                  }
                }),
              )

              const timeout = Effect.sleep(`${TEST_TIMEOUT_MS} millis`)
              const race = yield* Effect.raceAll([
                Effect.all([handle.exitCode, drain], { concurrency: 2 }).pipe(
                  Effect.map(([code]) => ({ kind: "exit" as const, code: Number(code) })),
                ),
                timeout.pipe(Effect.as({ kind: "timeout" as const, code: 1 })),
              ])
              parser.finish()
              if (race.kind === "timeout") {
                // Best-effort kill: the outer Effect.catch (beta.66) does not catch defects, so an
                // orDie here would let a failed kill escape and crash execute() on the real-timeout
                // path. Swallow the entire cause (failure AND defect) so the structured timeout
                // result below is produced independent of whether the kill actually succeeded.
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catchCause(() => Effect.void))
                const note = `\n\n[xcode_test] terminated after exceeding timeout ${TEST_TIMEOUT_MS} ms`
                parser.push(note)
                parser.finish()
                if (!sink && !rawLogNote) yield* openSink()
                if (sink) {
                  try {
                    sink.write(note)
                  } catch {
                    /* covered by the sink error handler */
                  }
                }
              }
              if (sink) {
                sink.end()
              }
              return { kind: "ran", parser, exitCode: race.code, rawLogPath, rawLogNote } satisfies Ran
            }),
          ).pipe(
            Effect.catch((e) =>
              Effect.succeed({
                kind: "spawn_failed",
                error: e instanceof Error ? e.message : String(e),
              } satisfies SpawnFailed),
            ),
          )

          const outcome: Ran | SpawnFailed = yield* run
          const durationMs = Date.now() - start

          const title = params.scheme ? `xcodebuild test: ${params.scheme}` : "xcodebuild test"

          if (outcome.kind === "spawn_failed") {
            const summary = {
              ok: false,
              status: "spawn_failed" as const,
              error: outcome.error,
              durationMs,
            }
            const metadata: XcodeTestMeta = { ok: false, status: "spawn_failed", error: outcome.error, durationMs }
            return { title, output: JSON.stringify(summary), metadata }
          }

          const parsed = outcome.parser.result(outcome.exitCode)

          const summary = {
            ok: parsed.ok,
            status: parsed.status,
            passed: parsed.passed,
            failed: parsed.failed,
            skipped: parsed.skipped,
            ...(parsed.failedTruncated ? { truncated: { failed: true } } : {}),
            ...(parsed.status === "build_failed"
              ? { buildErrors: parsed.buildErrors, buildWarnings: parsed.buildWarnings }
              : {}),
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            ...(outcome.parser.tailTruncated() ? { rawLogTruncated: true } : {}),
            ...(outcome.rawLogNote ? { rawLogNote: outcome.rawLogNote } : {}),
            durationMs,
          }

          const metadata: XcodeTestMeta = {
            ok: parsed.ok,
            status: parsed.status,
            passed: parsed.passed,
            failedCount: parsed.failed.length,
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            durationMs,
          }
          return { title, output: JSON.stringify(summary), metadata }
        }),
    }
  }),
)
