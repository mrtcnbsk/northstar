// kilocode_change - new file
// Shared xcodebuild execution primitive (W2-R2): the spawn -> stream -> bounded-parse ->
// timeout-race -> lazy-disk-sink block was duplicated nearly verbatim between xcode-build.ts and
// xcode-test.ts. This module extracts that orchestration into `runXcodebuild`, plus the generic
// "file:line:col: severity: message" diagnostic parser (`StreamingXcodeParser`) shared by
// xcode_build/xcode_archive/ipa_export — every xcodebuild subcommand that reports success/failure
// via a `** X SUCCEEDED/FAILED **` banner and file:line:col diagnostics.
//
// xcode_test does NOT reuse `StreamingXcodeParser`: its result shape (Test Case pass/fail,
// build-vs-test-failure disambiguation) is structurally different, so it keeps its own
// `StreamingXcodeTestParser` in xcode-test.ts. `runXcodebuild` is parser-agnostic — callers
// construct and inject whatever parser implements `XcodebuildStreamParser`, so the orchestration
// (which IS identical across build/test/archive/export) is shared while each tool's
// success/failure semantics stay exactly as they were before this refactor.
import { Effect, Stream } from "effect"
import { createWriteStream } from "node:fs"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Truncate from "@/tool/truncate"

// Bound the number of parsed diagnostics returned to the model. xcodebuild can emit thousands of
// lines; the raw log (rawLogPath) remains available for full detail. Shared by every tool that
// parses file:line:col diagnostics via StreamingXcodeParser (build/archive/export).
export const MAX_DIAGNOSTICS = 100

// Cap the raw-output tail retained in memory. xcodebuild logs run to thousands of lines; holding
// the whole thing as one growing JS string risks OOM/GC pressure on verbose or clean-build output.
// The streaming parser keeps only this many bytes of trailing text (for the human-facing preview)
// while every complete line is parsed as it arrives, so no diagnostic is ever dropped no matter
// how large the total output. The full log, when we keep one, is streamed to disk rather than
// accumulated in memory.
export const MAX_RETAINED_TAIL_BYTES = 256 * 1024

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

export const DIAGNOSTIC_RE = /^(.+?):(\d+):(\d+): (error|warning): (.+)$/

export const DEFAULT_SUCCESS_MARKER = "** BUILD SUCCEEDED **"
export const DEFAULT_FAIL_MARKER = "** BUILD FAILED **"

/**
 * Pure parser: turns raw xcodebuild stdout/stderr text + process exit code into a structured
 * result. No I/O, no Effect — safe to unit test with captured fixtures.
 *
 * `ok` requires BOTH a zero exit code AND the success marker present (with the fail marker
 * absent) in the output; a nonzero exit code always means failure even if the text claims
 * success, since exit code is the more trustworthy signal in that conflict.
 *
 * `successMarker`/`failMarker` default to xcode_build's `** BUILD SUCCEEDED/FAILED **` banners;
 * xcode_archive/ipa_export pass their own (`** ARCHIVE ... **` / `** EXPORT ... **`).
 */
export function parseXcodebuildOutput(
  output: string,
  exitCode: number,
  markers: { successMarker?: string; failMarker?: string } = {},
): ParsedBuild {
  const successMarker = markers.successMarker ?? DEFAULT_SUCCESS_MARKER
  const failMarker = markers.failMarker ?? DEFAULT_FAIL_MARKER
  const text = output ?? ""
  const buildSucceeded = text.includes(successMarker) && !text.includes(failMarker)

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
 *
 * `successMarker`/`failMarker` are constructor args (default to xcode_build's BUILD markers) so
 * xcode_archive/ipa_export can reuse this class with their own `** ARCHIVE/EXPORT ... **` banners
 * without duplicating the streaming/bounding logic.
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

  constructor(
    private readonly maxTailBytes: number = MAX_RETAINED_TAIL_BYTES,
    private readonly successMarker: string = DEFAULT_SUCCESS_MARKER,
    private readonly failMarker: string = DEFAULT_FAIL_MARKER,
  ) {}

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
    if (line.includes(this.successMarker)) this.sawSucceeded = true
    if (line.includes(this.failMarker)) this.sawFailed = true

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

  /** Cheap check (no allocation) for whether any diagnostic has been captured yet. Satisfies
   * `XcodebuildStreamParser.hasContent` — used by `runXcodebuild` to decide whether the raw log
   * is worth spilling to disk. */
  hasContent(): boolean {
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

/**
 * Minimal structural interface `runXcodebuild` needs from an injected parser: feed it chunks,
 * flush the trailing partial line, and answer whether spilling the raw log to disk is worth it.
 * `StreamingXcodeParser` (build/archive/export) and xcode-test.ts's `StreamingXcodeTestParser`
 * both implement this despite having entirely different `result()` shapes and internal regexes —
 * that divergence is exactly why `runXcodebuild` takes an already-constructed parser instead of
 * building one itself from success/fail markers.
 */
export interface XcodebuildStreamParser {
  push(chunk: string): void
  finish(): void
  retainedTail(): string
  hasContent(): boolean
}

export type RunXcodebuildOptions = {
  /** Binary to spawn. Defaults to "xcodebuild" — overridable only for testability. */
  command?: string
  args: string[]
  cwd: string
  timeoutMs: number
  /** Short tool id embedded in the timeout-termination note, e.g. "xcode_build" / "xcode_archive". */
  toolLabel: string
  /** Note appended to the raw log / summary when the disk sink fails (disk full / permission
   * denied). Defaults to a generic message; callers pass their own wording to preserve exact
   * pre-refactor text. */
  sinkErrorNote?: string
}

export type RunXcodebuildOutcome<P extends XcodebuildStreamParser> =
  | { spawnFailed: true; error: string }
  | { spawnFailed: false; parser: P; exitCode: number; rawLogPath?: string; rawLogNote?: string }

/**
 * Run an xcodebuild (sub)command to completion: spawn it, drain its combined stdout+stderr
 * through `parser` (streaming, bounded memory), lazily spill the full raw output to disk once the
 * parser reports there's something worth keeping, race the run against `timeoutMs`, and report a
 * `spawn_failed` outcome distinctly from a completed-but-failing run.
 *
 * This is the block that was duplicated near-verbatim between xcode-build.ts and xcode-test.ts
 * (W2-R2). It is intentionally parser-agnostic (see `XcodebuildStreamParser`) so xcode_build,
 * xcode_test, xcode_archive, and ipa_export can all share it while keeping their own
 * success/failure semantics.
 */
export function runXcodebuild<P extends XcodebuildStreamParser>(
  spawner: ChildProcessSpawner["Service"],
  trunc: Truncate.Interface,
  parser: P,
  options: RunXcodebuildOptions,
): Effect.Effect<RunXcodebuildOutcome<P>> {
  const { command = "xcodebuild", args, cwd, timeoutMs, toolLabel } = options
  const sinkErrorNote = options.sinkErrorNote ?? "raw log write failed (disk full or permission denied)"
  const cmd = ChildProcess.make(command, args, { cwd, stdin: "ignore" })

  const run = Effect.scoped(
    Effect.gen(function* () {
      // Spawn is caught SEPARATELY below so a toolchain/spawn failure (xcodebuild missing, bad
      // cwd, PlatformError) is not masked as a run that "failed" with zero diagnostics/results.
      const handle = yield* spawner.spawn(cmd)

      // Lazily-opened disk sink for the full raw log. Sink errors degrade gracefully: a
      // disk-full / permission failure records a note but never fails the run's result.
      let sink: ReturnType<typeof createWriteStream> | undefined
      let rawLogPath: string | undefined
      let rawLogNote: string | undefined

      const openSink = Effect.fnUntraced(function* () {
        if (sink || rawLogNote) return
        // trunc.write reserves a path in the truncation dir (its fs ops orDie internally, so it
        // cannot fail here); the real disk-full/permission risk is the write stream, handled by
        // the "error" listener below which degrades to a note.
        const path = yield* trunc.write("")
        rawLogPath = path
        sink = createWriteStream(path, { flags: "a" })
        sink.on("error", () => {
          rawLogNote = sinkErrorNote
          sink = undefined
        })
        // Preface the disk log with the tail retained so far (bounded), so early output up to
        // the retention cap is preserved on disk.
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
          if (!sink && !rawLogNote && parser.hasContent()) {
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

      const timeout = Effect.sleep(`${timeoutMs} millis`)
      const race = yield* Effect.raceAll([
        Effect.all([handle.exitCode, drain], { concurrency: 2 }).pipe(
          Effect.map(([code]) => ({ kind: "exit" as const, code: Number(code) })),
        ),
        timeout.pipe(Effect.as({ kind: "timeout" as const, code: 1 })),
      ])
      parser.finish()
      if (race.kind === "timeout") {
        // Best-effort kill: the outer Effect.catch (beta.66) does not catch defects, so an orDie
        // here would let a failed kill escape and crash execute() on the real-timeout path.
        // Swallow the entire cause (failure AND defect) so the structured timeout result below is
        // produced independent of whether the kill actually succeeded.
        yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catchCause(() => Effect.void))
        const note = `\n\n[${toolLabel}] terminated after exceeding timeout ${timeoutMs} ms`
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
      return { spawnFailed: false, parser, exitCode: race.code, rawLogPath, rawLogNote } as RunXcodebuildOutcome<P>
    }),
  ).pipe(
    // Only spawn/launch failures land here; the drain above never fails (sink errors are
    // swallowed and recorded as a note), so a "spawn_failed" outcome is unambiguous.
    Effect.catch((e) =>
      Effect.succeed({
        spawnFailed: true,
        error: e instanceof Error ? e.message : String(e),
      } as RunXcodebuildOutcome<P>),
    ),
  )

  return run
}
