// kilocode_change - new file
import { Effect, Schema, Stream } from "effect"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Tool from "@/tool/tool"
import DESCRIPTION from "./crash-symbolicate.txt"

// Symbolication is a short-lived, low-output operation (one atos invocation resolving a bounded
// number of addresses). 30s is generous for atos startup + DWARF lookup on a large dSYM without
// risking the debug worker hanging indefinitely on a hung/missing toolchain.
export const SYMBOLICATE_TIMEOUT_MS = 30 * 1000

// The crash log itself (the *input*), not the tool's output, is the thing that can be
// pathologically large (a corrupted or synthetic log). Unlike xcode_build/xcode_test — whose
// OUTPUT is unboundedly large and needs a streaming parser — crash_symbolicate's output is
// inherently small (one resolved line per frame, and a real crash has at most a few hundred
// frames). So we bound the *input* we are willing to read/parse instead of streaming the output.
export const MAX_CRASH_LOG_BYTES = 256 * 1024
export const MAX_FRAMES = 500

export const Params = Schema.Struct({
  crashLog: Schema.String.annotate({
    description:
      "Raw crash log text, or a filesystem path to a .crash/.ips/.txt file containing one. If the string is an existing file path, its contents are read.",
  }),
  dsymPath: Schema.String.annotate({
    description: "Path to the .dSYM bundle, or directly to the binary inside Contents/Resources/DWARF/.",
  }),
  arch: Schema.optional(Schema.String).annotate({
    description: "CPU architecture for atos -arch. Defaults to arm64, or the crash log's Code Type when parseable.",
  }),
  loadAddress: Schema.optional(Schema.String).annotate({
    description: "Override the app image's load address instead of parsing it from Binary Images.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type BinaryImage = {
  name: string
  loadAddress: string
  uuid?: string
  path?: string
}

export type CrashFrame = {
  /** The frame number as printed in the crash log. NOT globally unique — Apple's crash-reporter
   * format restarts numbering at 0 for every thread, so `index` alone cannot identify a frame
   * across the whole log. Use `seq` for that. */
  index: number
  /** Globally unique position of this frame within `frames`, stable regardless of thread
   * boundaries. Used internally (and by callers) to key resolved-symbol maps unambiguously. */
  seq: number
  image: string
  address: string
  raw: string
}

export type ParsedCrash = {
  images: BinaryImage[]
  frames: CrashFrame[]
  threadCount?: number
  codeType?: string
  /** The process name from the crash log's `Process:` header (e.g. "Keel" from "Process: Keel
   * [1234]") — the authoritative signal for "which binary image is the app", independent of
   * which thread happened to crash (a kernel-triggered crash can put a system frame on top). */
  processName?: string
  /** The binary image name of frame 0 of the crashed thread (the "Thread N Crashed:" block).
   * Used only as a FALLBACK when `processName` is absent or doesn't match any parsed image. */
  crashedImage?: string
}

// `0x104f28000 - 0x104f5ffff Keel arm64  <a1b2c3d4e5f647a8b9c0d1e2f3a4b5c6> /path/to/Keel`
const BINARY_IMAGE_RE = /^\s*(0x[0-9a-fA-F]+)\s*-\s*0x[0-9a-fA-F]+\s+(\S+)\s+\S+\s*(?:<([0-9a-fA-F]+)>)?\s*(.*)$/

// `12  Keel                          0x0000000104f2c1a0 0x104f28000 + 16800`
const FRAME_RE = /^(\d+)\s+(\S+)\s+(0x[0-9a-fA-F]+)\s+/

const THREAD_HEADER_RE = /^Thread \d+( Crashed)?:/

// `Code Type:             ARM-64` / `Code Type:  arm64e (Native)`
const CODE_TYPE_RE = /^Code Type:\s*([^\s(]+)/i

// `Process:              Keel [1234]`
const PROCESS_RE = /^Process:\s*(\S+)\s*\[\d+\]/i

/**
 * Pure parser: extracts binary images and backtrace frames from a raw Apple crash-reporter log.
 * No I/O, no Effect — safe to unit test with captured fixtures.
 *
 * Only lines inside a "Thread N:" / "Thread N Crashed:" block that match the frame shape are
 * counted as frames (this avoids false positives from other numbered lists in the log). The
 * "Binary Images:" section is scanned independently of thread state, since it always comes after
 * all thread backtraces in the standard format but we don't want to depend on section ordering.
 */
export function parseCrashLog(crashLog: string): ParsedCrash {
  const text = (crashLog ?? "").slice(0, MAX_CRASH_LOG_BYTES)
  const lines = text.split(/\r?\n/)

  const images: BinaryImage[] = []
  const frames: CrashFrame[] = []
  let threadCount = 0
  let inThread = false
  let inCrashedThread = false
  let inBinaryImages = false
  let codeType: string | undefined
  let crashedImage: string | undefined
  let processName: string | undefined

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    const codeTypeMatch = CODE_TYPE_RE.exec(line)
    if (codeTypeMatch) codeType = codeTypeMatch[1]
    if (processName === undefined) {
      const processMatch = PROCESS_RE.exec(line)
      if (processMatch) processName = processMatch[1]
    }

    const threadHeader = THREAD_HEADER_RE.exec(line)
    if (threadHeader) {
      threadCount++
      inThread = true
      inCrashedThread = threadHeader[1] !== undefined
      inBinaryImages = false
      continue
    }
    if (/^Binary Images:/.test(line)) {
      inBinaryImages = true
      inThread = false
      inCrashedThread = false
      continue
    }
    // A blank-separated section end: any other all-caps header-ish line ends the current thread
    // block. We detect this cheaply by requiring frame lines to start with a digit; anything else
    // while inThread just falls through without matching FRAME_RE, which is harmless.

    if (inBinaryImages) {
      const m = BINARY_IMAGE_RE.exec(line)
      if (m && images.length < MAX_FRAMES) {
        const [, loadAddress, name, uuid, imgPath] = m
        images.push({
          name,
          loadAddress,
          ...(uuid ? { uuid } : {}),
          ...(imgPath ? { path: imgPath } : {}),
        })
      }
      continue
    }

    if (inThread) {
      const m = FRAME_RE.exec(line)
      if (m) {
        if (frames.length >= MAX_FRAMES) continue
        const [, idx, image, address] = m
        frames.push({ index: Number(idx), seq: frames.length, image, address, raw: line })
        // The crashed image is identified by frame 0 of the "Thread N Crashed:" block — the
        // standard symbolication heuristic (the top of the crashing thread's own backtrace).
        if (inCrashedThread && Number(idx) === 0 && crashedImage === undefined) crashedImage = image
      }
    }
  }

  return {
    images,
    frames,
    ...(threadCount > 0 ? { threadCount } : {}),
    ...(codeType ? { codeType } : {}),
    ...(processName ? { processName } : {}),
    ...(crashedImage ? { crashedImage } : {}),
  }
}

/** Normalize a Code Type field ("ARM-64", "arm64e (Native)", "X86-64") into an `atos -arch` value. */
export function normalizeArch(codeType: string | undefined): string {
  if (!codeType) return "arm64"
  const lower = codeType.toLowerCase()
  if (lower.startsWith("arm-64") || lower === "arm64") return "arm64"
  if (lower.startsWith("arm64e")) return "arm64e"
  if (lower.startsWith("x86-64") || lower.startsWith("x86_64")) return "x86_64"
  return lower.replace(/[^a-z0-9_]/g, "") || "arm64"
}

/** Resolve a user-provided dSYM path (bundle dir or binary file) to the actual DWARF binary atos
 * needs via `-o`. Returns undefined if nothing resolvable exists on disk. */
export function resolveDsymBinary(dsymPath: string): string | undefined {
  if (!dsymPath) return undefined
  if (!existsSync(dsymPath)) return undefined
  const stat = statSync(dsymPath)
  if (stat.isFile()) return dsymPath
  if (!stat.isDirectory()) return undefined

  const dwarfDir = dsymPath.endsWith(".dSYM")
    ? path.join(dsymPath, "Contents", "Resources", "DWARF")
    : existsSync(path.join(dsymPath, "Contents", "Resources", "DWARF"))
      ? path.join(dsymPath, "Contents", "Resources", "DWARF")
      : undefined
  if (!dwarfDir || !existsSync(dwarfDir)) return undefined

  try {
    const entries = readdirSync(dwarfDir)
    const binary = entries.find((entry) => !entry.startsWith("."))
    return binary ? path.join(dwarfDir, binary) : undefined
  } catch {
    return undefined
  }
}

/** Read `crashLog` as literal text, unless it is an existing filesystem path, in which case its
 * (bounded) contents are read. Never throws — a read failure just falls back to treating the
 * input as literal text. */
export function resolveCrashLogText(crashLog: string): string {
  if (!crashLog) return ""
  // Heuristic: only bother stat'ing candidates that look path-like, to avoid a syscall for every
  // multi-line crash log blob (which will never be a valid path anyway).
  const looksLikePath = !crashLog.includes("\n") && crashLog.length < 4096
  if (!looksLikePath) return crashLog
  try {
    if (existsSync(crashLog) && statSync(crashLog).isFile()) {
      return readFileSync(crashLog, "utf-8").slice(0, MAX_CRASH_LOG_BYTES)
    }
  } catch {
    /* fall through to literal text */
  }
  return crashLog
}

export type SymbolicatedFrame = CrashFrame & {
  symbol?: string
  resolved: boolean
}

export type SymbolicateSummary = {
  ok: boolean
  framesResolved: number
  framesTotal: number
  symbolicated: string
  unresolvedNote?: string
  note?: string
}

/** Merge atos's resolved-line output back onto the app-image frames it was run against, in the
 * same order they were sent. atos returns one output line per input address; a line identical to
 * (or still containing) the input hex address means atos could not resolve it — left as raw. */
export function mergeAtosOutput(frames: CrashFrame[], atosOutput: string): SymbolicatedFrame[] {
  const lines = atosOutput.split(/\r?\n/).filter((l) => l.length > 0)
  return frames.map((frame, i) => {
    const resolvedLine = lines[i]
    if (!resolvedLine) return { ...frame, resolved: false }
    // atos echoes the input address verbatim (optionally in parens) when it cannot resolve it,
    // e.g. "0x0000000104f2c1a0" or "0x104f2c1a0 (in Keel)". Any line NOT containing the raw
    // address token is treated as a genuine symbol resolution.
    const stillRaw = resolvedLine.includes(frame.address) || resolvedLine === frame.address
    if (stillRaw) return { ...frame, resolved: false }
    return { ...frame, symbol: resolvedLine.trim(), resolved: true }
  })
}

/** Render the full backtrace text with app-image frames replaced by their resolved symbol lines,
 * leaving every other line (system frames, thread headers, etc.) untouched. Keyed by `seq`
 * (globally unique), NOT `index` (the log's own per-thread frame number, which repeats across
 * threads and would collide two "frame 0"s from different threads onto the same map entry). */
export function renderSymbolicatedTrace(parsed: ParsedCrash, resolved: Map<number, string>): string {
  const lines: string[] = []
  for (const frame of parsed.frames) {
    const symbol = resolved.get(frame.seq)
    lines.push(symbol ? `${frame.index}  ${frame.image}  ${frame.address}  ${symbol}` : frame.raw)
  }
  return lines.join("\n")
}

export const CrashSymbolicateTool = Tool.define(
  "crash_symbolicate",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "crash_symbolicate",
            patterns: ["*"],
            always: ["*"],
            metadata: { dsymPath: params.dsymPath },
          })

          const start = Date.now()
          const crashText = resolveCrashLogText(params.crashLog)
          const parsed = parseCrashLog(crashText)
          const title = "crash_symbolicate"

          // Identify the app's own binary image via the crash log's `Process:` header (the
          // authoritative signal), falling back to the crashed thread's frame-0 image only if the
          // header is absent/unmatched. NOT images[0] — the Binary Images section lists images in
          // load order, which does not reliably put the app first, and using "whatever's on top of
          // the crashed thread" alone would misidentify a system framework as "the app" for a
          // kernel-triggered crash (e.g. a stack overflow surfacing in libsystem_kernel).
          const appImageName = parsed.processName ?? parsed.crashedImage
          const appImage = appImageName ? parsed.images.find((img) => img.name === appImageName) : undefined
          const appFrames = appImage ? parsed.frames.filter((f) => f.image === appImage.name) : []

          const rawSummary = (note: string): SymbolicateSummary => ({
            ok: false,
            framesResolved: 0,
            framesTotal: parsed.frames.length,
            symbolicated: parsed.frames.map((f) => f.raw).join("\n"),
            note,
          })

          if (parsed.frames.length === 0) {
            const summary = rawSummary("No backtrace frames could be parsed from the crash log.")
            return { title, output: JSON.stringify(summary), metadata: summary }
          }

          if (!appImage || appFrames.length === 0) {
            const summary = rawSummary(
              "No frames from the crashed app's own binary image were found (only system frames present); nothing to symbolicate.",
            )
            return { title, output: JSON.stringify(summary), metadata: summary }
          }

          const dsymBinary = resolveDsymBinary(params.dsymPath)
          if (!dsymBinary) {
            const summary = rawSummary(
              `dSYM not found or unreadable at "${params.dsymPath}". Returning the raw (unsymbolicated) trace.`,
            )
            return { title, output: JSON.stringify(summary), metadata: summary }
          }

          const loadAddress = params.loadAddress ?? appImage!.loadAddress
          const arch = params.arch ?? normalizeArch(parsed.codeType)
          const addresses = appFrames.map((f) => f.address)
          const args = ["-o", dsymBinary, "-arch", arch, "-l", loadAddress, ...addresses]
          const command = ChildProcess.make("atos", args, { stdin: "ignore" })

          type Ran = { kind: "ran"; output: string; exitCode: number; timedOut: boolean }
          type SpawnFailed = { kind: "spawn_failed"; error: string }

          const run = Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(command)
              let output = ""
              const drain = Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.sync(() => {
                  output += chunk
                }),
              )
              const timeout = Effect.sleep(`${SYMBOLICATE_TIMEOUT_MS} millis`)
              const race = yield* Effect.raceAll([
                Effect.all([handle.exitCode, drain], { concurrency: 2 }).pipe(
                  Effect.map(([code]) => ({ kind: "exit" as const, code: Number(code) })),
                ),
                timeout.pipe(Effect.as({ kind: "timeout" as const, code: 1 })),
              ])
              if (race.kind === "timeout") {
                // Best-effort kill: this tool's whole contract is "never crash the debug worker",
                // so a kill that itself fails/defects must NOT escape. Effect.catch (beta.66) does
                // not catch defects, so orDie here would let a failed kill crash execute() on the
                // real-timeout path. Swallow the entire cause (failure AND defect) and continue —
                // the structured return below is independent of the kill outcome.
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.catchCause(() => Effect.void))
              }
              return { kind: "ran", output, exitCode: race.code, timedOut: race.kind === "timeout" } satisfies Ran
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

          if (outcome.kind === "spawn_failed") {
            const summary = rawSummary(
              `Symbolizer unavailable: atos could not be launched (${outcome.error}). Install Xcode command-line tools. Returning the raw (unsymbolicated) trace.`,
            )
            const metadata = { ...summary, durationMs }
            return { title, output: JSON.stringify(metadata), metadata }
          }

          if (outcome.timedOut) {
            // atos ran past the timeout and was (best-effort) killed. Whatever partial output it
            // produced is unreliable, so return the raw trace with a clear timeout note rather than
            // half-merged results — and, per the never-crash contract, this return is independent
            // of whether the kill above actually succeeded.
            const summary = {
              ...rawSummary(`Symbolication timed out after ${SYMBOLICATE_TIMEOUT_MS / 1000}s. Returning the raw (unsymbolicated) trace.`),
              durationMs,
            }
            return { title, output: JSON.stringify(summary), metadata: summary }
          }

          const merged = mergeAtosOutput(appFrames, outcome.output)
          const resolvedBySeq = new Map(merged.filter((f) => f.resolved && f.symbol).map((f) => [f.seq, f.symbol!]))
          const symbolicated = renderSymbolicatedTrace(parsed, resolvedBySeq)
          const framesResolved = merged.filter((f) => f.resolved).length

          const summary: SymbolicateSummary & { durationMs: number } = {
            ok: framesResolved > 0,
            framesResolved,
            framesTotal: parsed.frames.length,
            symbolicated,
            durationMs,
            ...(framesResolved < appFrames.length
              ? {
                  unresolvedNote: `${appFrames.length - framesResolved} of ${appFrames.length} app-image frame(s) could not be resolved by atos (mismatched dSYM UUID, stripped symbols, or an inlined/optimized frame).`,
                }
              : {}),
          }
          return { title, output: JSON.stringify(summary), metadata: summary }
        }),
    }
  }),
)
