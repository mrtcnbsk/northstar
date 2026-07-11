// kilocode_change - new file
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "@/tool/truncate"
import { validateExtraArgs } from "./xcode-argv"
import {
  MAX_DIAGNOSTICS,
  MAX_RETAINED_TAIL_BYTES,
  parseXcodebuildOutput,
  StreamingXcodeParser,
  runXcodebuild,
  type Diagnostic,
  type ParsedBuild,
} from "./xcodebuild-exec"
import DESCRIPTION from "./xcode-build.txt"

// Re-exported so existing imports (`import { MAX_DIAGNOSTICS, MAX_RETAINED_TAIL_BYTES,
// parseXcodebuildOutput, StreamingXcodeParser } from "./xcode-build"`) keep working after the
// W2-R2 extraction moved their implementations into the shared xcodebuild-exec.ts primitive.
export { MAX_DIAGNOSTICS, MAX_RETAINED_TAIL_BYTES, parseXcodebuildOutput, StreamingXcodeParser }
export type { Diagnostic, ParsedBuild }

// Builds can legitimately run long (clean builds, large workspaces, CI-grade schemes).
// 10 minutes is generous enough to avoid false timeouts while still bounding a single
// build attempt inside a build-loop budget.
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000

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

          // A build runs the process and drains its output through the bounded streaming parser
          // (default markers: "** BUILD SUCCEEDED/FAILED **"). The full log is spilled to disk
          // lazily (only once a diagnostic appears — a clean build with no diagnostics leaves no
          // raw log, per disk-hygiene), so in-memory retention is capped regardless of how
          // verbose the build is. See xcodebuild-exec.ts (W2-R2) for the shared spawn/stream/
          // timeout/sink orchestration this delegates to.
          const outcome = yield* runXcodebuild(spawner, trunc, new StreamingXcodeParser(), {
            args,
            cwd,
            timeoutMs: BUILD_TIMEOUT_MS,
            toolLabel: "xcode_build",
            sinkErrorNote: "raw log write failed (disk full or permission denied); diagnostics above are complete",
          })
          const durationMs = Date.now() - start

          const title = params.scheme ? `xcodebuild: ${params.scheme}` : "xcodebuild"

          if (outcome.spawnFailed) {
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
