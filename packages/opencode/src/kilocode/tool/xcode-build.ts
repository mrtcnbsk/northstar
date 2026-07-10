// kilocode_change - new file
import { Effect, Schema, Stream } from "effect"
import { createWriteStream } from "node:fs"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "@/tool/truncate"
import { validateExtraArgs } from "./xcode-argv"
import DESCRIPTION from "./xcode-build.txt"

// Builds can legitimately run long (clean builds, large workspaces, CI-grade schemes).
// 10 minutes is generous enough to avoid false timeouts while still bounding a single
// build attempt inside a build-loop budget.
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000

// Bound the number of parsed diagnostics returned to the model. xcodebuild can emit
// thousands of lines; the raw log (rawLogPath) remains available for full detail.
export const MAX_DIAGNOSTICS = 100

// Cap the raw-output tail retained in memory. xcodebuild logs run to thousands of lines;
// holding the whole thing as one growing JS string risks OOM/GC pressure on verbose or
// clean-build output. The streaming parser keeps only this many bytes of trailing text
// (for the human-facing preview) while every complete line is parsed as it arrives, so no
// diagnostic is ever dropped no matter how large the total output. The full log, when we
// keep one, is streamed to disk rather than accumulated in memory.
export const MAX_RETAINED_TAIL_BYTES = 256 * 1024

export const Params = Schema.Struct({
  scheme: Schema.optional(Schema.String).annotate({ description: "Xcode scheme to build" }),
  workspace: Schema.optional(Schema.String).annotate({ description: "Path to an .xcworkspace" }),
  project: Schema.optional(Schema.String).annotate({ description: "Path to an .xcodeproj" }),
  configuration: Schema.optional(Schema.String).annotate({
    description: "Build configuration, defaults to Debug",
  }),
  destination: Schema.optional(Schema.String).annotate({
    description: "xcodebuild destination specifier, e.g. 'platform=iOS Simulator,name=iPhone 15'",
  }),
  extraArgs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional raw arguments appended to the xcodebuild invocation",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type Diagnostic = {
  file: string
  line: number
  column: number
  severity: "error" | "warning"
  message: string
}

export type ParsedBuild = {
  ok: boolean
  buildSucceeded: boolean
  errors: Diagnostic[]
  warnings: Diagnostic[]
  errorTruncated: boolean
  warningTruncated: boolean
}

// Shared metadata shape across every execute() return path (invalid args, spawn failure, build
// outcome) — Tool.define infers execute()'s return type from its first `return`, so every branch
// must satisfy one common type rather than each narrowing independently.
export type XcodeBuildMeta = {
  ok: boolean
  status: "invalid_args" | "spawn_failed" | "build_failed" | "build_succeeded"
  error?: string
  errorCount?: number
  warningCount?: number
  rawLogPath?: string
  durationMs?: number
}

const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+): (error|warning): (.+)$/

/** Build the xcodebuild argv from tool params. Only includes flags that were provided. */
export function buildArgs(params: Params): string[] {
  const args = ["build"]
  if (params.workspace) args.push("-workspace", params.workspace)
  if (params.project) args.push("-project", params.project)
  if (params.scheme) args.push("-scheme", params.scheme)
  args.push("-configuration", params.configuration ?? "Debug")
  if (params.destination) args.push("-destination", params.destination)
  if (params.extraArgs) args.push(...params.extraArgs)
  return args
}

/**
 * Pure parser: turns raw xcodebuild stdout/stderr text + process exit code into a
 * structured result. No I/O, no Effect — safe to unit test with captured fixtures.
 *
 * `ok` requires BOTH a zero exit code AND a "** BUILD SUCCEEDED **" marker in the
 * output; a nonzero exit code always means failure even if the text claims success,
 * since exit code is the more trustworthy signal in that conflict.
 */
export function parseXcodebuildOutput(output: string, exitCode: number): ParsedBuild {
  const text = output ?? ""
  const buildSucceeded = text.includes("** BUILD SUCCEEDED **") && !text.includes("** BUILD FAILED **")

  const errors: Diagnostic[] = []
  const warnings: Diagnostic[] = []
  let errorTruncated = false
  let warningTruncated = false

  for (const line of text.split(/\r?\n/)) {
    const match = DIAGNOSTIC_RE.exec(line.trim())
    if (!match) continue
    const [, file, lineNo, col, severity, message] = match
    const diagnostic: Diagnostic = {
      file,
      line: Number(lineNo),
      column: Number(col),
      severity: severity as "error" | "warning",
      message,
    }
    if (severity === "error") {
      if (errors.length < MAX_DIAGNOSTICS) errors.push(diagnostic)
      else errorTruncated = true
    } else {
      if (warnings.length < MAX_DIAGNOSTICS) warnings.push(diagnostic)
      else warningTruncated = true
    }
  }

  return {
    ok: buildSucceeded && exitCode === 0,
    buildSucceeded,
    errors,
    warnings,
    errorTruncated,
    warningTruncated,
  }
}

/**
 * Streaming, line-buffered xcodebuild parser with bounded memory.
 *
 * The naive approach (accumulate the entire log into one growing string, then parse) risks
 * OOM/GC pressure because xcodebuild output routinely runs to thousands of lines. Instead we
 * parse each complete line the moment it arrives and retain only:
 *   - the diagnostics arrays (already capped at MAX_DIAGNOSTICS each), and
 *   - a bounded tail of the raw text (MAX_RETAINED_TAIL_BYTES) for the human-facing preview.
 *
 * Because the diagnostic regex runs per-line as chunks stream in, **no diagnostic is ever
 * dropped no matter how large the total output** — an error that appears after megabytes of
 * noise is captured just the same. Only the raw-text preview is bounded; the full log, when
 * kept, is streamed to disk by the caller, never held in memory.
 */
export class StreamingXcodeParser {
  private pending = ""
  private tail = ""
  private tailBytes = 0
  private everTrimmed = false
  private sawSucceeded = false
  private sawFailed = false
  private readonly errors: Diagnostic[] = []
  private readonly warnings: Diagnostic[] = []
  private errorTruncated = false
  private warningTruncated = false

  constructor(private readonly maxTailBytes: number = MAX_RETAINED_TAIL_BYTES) {}

  /** Feed a chunk of stdout/stderr. Complete lines are parsed immediately; a partial trailing
   * line is buffered until the next chunk (or finish()) completes it. */
  push(chunk: string): void {
    if (!chunk) return
    this.retainTail(chunk)
    this.pending += chunk
    let nl = this.pending.indexOf("\n")
    while (nl !== -1) {
      // Slice off the completed line (without the newline) and parse it.
      this.consumeLine(this.pending.slice(0, nl))
      this.pending = this.pending.slice(nl + 1)
      nl = this.pending.indexOf("\n")
    }
  }

  /** Flush any buffered partial line. Call once the stream has ended. */
  finish(): void {
    if (this.pending.length > 0) {
      this.consumeLine(this.pending)
      this.pending = ""
    }
  }

  private consumeLine(line: string): void {
    if (line.includes("** BUILD SUCCEEDED **")) this.sawSucceeded = true
    if (line.includes("** BUILD FAILED **")) this.sawFailed = true

    const match = DIAGNOSTIC_RE.exec(line.trim())
    if (!match) return
    const [, file, lineNo, col, severity, message] = match
    const diagnostic: Diagnostic = {
      file,
      line: Number(lineNo),
      column: Number(col),
      severity: severity as "error" | "warning",
      message,
    }
    if (severity === "error") {
      if (this.errors.length < MAX_DIAGNOSTICS) this.errors.push(diagnostic)
      else this.errorTruncated = true
    } else {
      if (this.warnings.length < MAX_DIAGNOSTICS) this.warnings.push(diagnostic)
      else this.warningTruncated = true
    }
  }

  /** Keep at most maxTailBytes of trailing raw text for the preview, discarding older bytes. */
  private retainTail(chunk: string): void {
    this.tail += chunk
    this.tailBytes += Buffer.byteLength(chunk, "utf-8")
    if (this.tailBytes <= this.maxTailBytes) return
    // Trim from the front until we are back under the cap. `overshoot` is a byte count but
    // slice() cuts UTF-16 code units; since a code unit encodes >= 1 byte, cutting that many
    // code units removes at least `overshoot` bytes, so the byte-cap invariant always holds.
    // On multi-byte (non-ASCII) output this may under-retain the preview slightly — purely
    // cosmetic, as diagnostics live in the parsed arrays and are never sourced from the tail.
    const overshoot = this.tailBytes - this.maxTailBytes
    this.tail = this.tail.slice(Math.min(overshoot, this.tail.length))
    this.tailBytes = Buffer.byteLength(this.tail, "utf-8")
    this.everTrimmed = true
  }

  /** The bounded trailing slice of raw output, for the human-facing preview / raw log. */
  retainedTail(): string {
    return this.tail
  }

  /** Whether any raw output was discarded from the retained tail (i.e. the tail is partial). */
  tailTruncated(): boolean {
    return this.everTrimmed
  }

  /** Cheap check (no allocation) for whether any diagnostic has been captured yet. */
  hasDiagnostics(): boolean {
    return this.errors.length > 0 || this.warnings.length > 0
  }

  result(exitCode: number): ParsedBuild {
    const buildSucceeded = this.sawSucceeded && !this.sawFailed
    return {
      ok: buildSucceeded && exitCode === 0,
      buildSucceeded,
      errors: this.errors,
      warnings: this.warnings,
      errorTruncated: this.errorTruncated,
      warningTruncated: this.warningTruncated,
    }
  }
}

export const XcodeBuildTool = Tool.define(
  "xcode_build",
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
          const args = buildArgs(params)

          // Reject path-escaping/blast-radius-widening extraArgs BEFORE prompting for permission
          // or spawning xcodebuild: this is a hard input-validation failure, not something a
          // permission grant should be able to bless. See xcode-argv.ts for the denylist rationale.
          const argvError = validateExtraArgs(params.extraArgs)
          if (argvError) {
            const title = params.scheme ? `xcodebuild: ${params.scheme}` : "xcodebuild"
            const metadata: XcodeBuildMeta = { ok: false, status: "invalid_args", error: argvError }
            return { title, output: JSON.stringify(metadata), metadata }
          }

          yield* ctx.ask({
            permission: "xcode_build",
            patterns: [params.scheme ?? "*"],
            always: [params.scheme ?? "*"],
            metadata: { scheme: params.scheme, workspace: params.workspace, project: params.project },
          })

          const start = Date.now()
          const command = ChildProcess.make("xcodebuild", args, { cwd, stdin: "ignore" })

          // A build runs the process and drains its output through the bounded streaming parser.
          // The full log is spilled to disk lazily (only once a diagnostic or failure marker
          // appears — a clean build with no diagnostics leaves no raw log, per disk-hygiene),
          // so in-memory retention is capped regardless of how verbose the build is.
          type Ran = { kind: "ran"; parser: StreamingXcodeParser; exitCode: number; rawLogPath?: string; rawLogNote?: string }
          type SpawnFailed = { kind: "spawn_failed"; error: string }

          const run = Effect.scoped(
            Effect.gen(function* () {
              // Spawn is caught SEPARATELY below so a toolchain/spawn failure (xcodebuild missing,
              // bad cwd, PlatformError) is not masked as a build that "failed" with zero diagnostics.
              const handle = yield* spawner.spawn(command)
              const parser = new StreamingXcodeParser()

              // Lazily-opened disk sink for the full raw log. Sink errors degrade gracefully:
              // a disk-full / permission failure records a note but never fails the build result.
              let sink: ReturnType<typeof createWriteStream> | undefined
              let rawLogPath: string | undefined
              let rawLogNote: string | undefined

              const openSink = Effect.fnUntraced(function* () {
                if (sink || rawLogNote) return
                // trunc.write reserves a path in the truncation dir (its fs ops orDie internally,
                // so it cannot fail here); the real disk-full/permission risk is the write stream,
                // handled by the "error" listener below which degrades to a note.
                const path = yield* trunc.write("")
                rawLogPath = path
                sink = createWriteStream(path, { flags: "a" })
                sink.on("error", () => {
                  rawLogNote = "raw log write failed (disk full or permission denied); diagnostics above are complete"
                  sink = undefined
                })
                // Preface the disk log with the tail retained so far (bounded), so early output
                // up to the retention cap is preserved on disk.
                try {
                  sink.write(parser.retainedTail())
                } catch {
                  /* covered by the sink error handler above */
                }
              })

              const drain = Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.gen(function* () {
                  parser.push(chunk)
                  // Once we know the log is worth keeping, spill everything to disk.
                  if (!sink && !rawLogNote && parser.hasDiagnostics()) {
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

              const timeout = Effect.sleep(`${BUILD_TIMEOUT_MS} millis`)
              const race = yield* Effect.raceAll([
                Effect.all([handle.exitCode, drain], { concurrency: 2 }).pipe(
                  Effect.map(([code]) => ({ kind: "exit" as const, code: Number(code) })),
                ),
                timeout.pipe(Effect.as({ kind: "timeout" as const, code: 1 })),
              ])
              parser.finish()
              if (race.kind === "timeout") {
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
                const note = `\n\n[xcode_build] terminated after exceeding timeout ${BUILD_TIMEOUT_MS} ms`
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
            // Only spawn/launch failures land here; the drain above never fails (sink errors are
            // swallowed and recorded as a note), so a "spawn_failed" result is unambiguous.
            Effect.catch((e) =>
              Effect.succeed({
                kind: "spawn_failed",
                error: e instanceof Error ? e.message : String(e),
              } satisfies SpawnFailed),
            ),
          )

          const outcome: Ran | SpawnFailed = yield* run
          const durationMs = Date.now() - start

          const title = params.scheme ? `xcodebuild: ${params.scheme}` : "xcodebuild"

          if (outcome.kind === "spawn_failed") {
            // Distinct from a build failure: the toolchain/process never produced diagnostics.
            const summary = {
              ok: false,
              status: "spawn_failed" as const,
              error: outcome.error,
              durationMs,
            }
            const metadata: XcodeBuildMeta = { ok: false, status: "spawn_failed", error: outcome.error, durationMs }
            return { title, output: JSON.stringify(summary), metadata }
          }

          const parsed = outcome.parser.result(outcome.exitCode)
          const status = parsed.ok ? ("build_succeeded" as const) : ("build_failed" as const)

          const summary = {
            ok: parsed.ok,
            status,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            errors: parsed.errors,
            warnings: parsed.warnings,
            ...(parsed.errorTruncated || parsed.warningTruncated
              ? { truncated: { errors: parsed.errorTruncated, warnings: parsed.warningTruncated } }
              : {}),
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            ...(outcome.parser.tailTruncated() ? { rawLogTruncated: true } : {}),
            ...(outcome.rawLogNote ? { rawLogNote: outcome.rawLogNote } : {}),
            durationMs,
          }

          const metadata: XcodeBuildMeta = {
            ok: parsed.ok,
            status,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            durationMs,
          }
          return { title, output: JSON.stringify(summary), metadata }
        }),
    }
  }),
)
