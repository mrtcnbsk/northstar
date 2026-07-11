// kilocode_change - new file
import { Effect, Schema } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "@/tool/truncate"
import { validateExtraArgs, validatePath } from "./xcode-argv"
import { StreamingXcodeParser, runXcodebuild } from "./xcodebuild-exec"
import DESCRIPTION from "./xcode-archive.txt"

// Archives can legitimately run long (large workspaces, CI-grade schemes) — mirrors
// xcode_build's budget.
export const ARCHIVE_TIMEOUT_MS = 10 * 60 * 1000

const SUCCESS_MARKER = "** ARCHIVE SUCCEEDED **"
const FAIL_MARKER = "** ARCHIVE FAILED **"

export const Params = Schema.Struct({
  scheme: Schema.String.annotate({ description: "Xcode scheme to archive" }),
  workspace: Schema.optional(Schema.String).annotate({ description: "Path to an .xcworkspace" }),
  project: Schema.optional(Schema.String).annotate({ description: "Path to an .xcodeproj" }),
  configuration: Schema.optional(Schema.String).annotate({
    description: "Build configuration, defaults to Release",
  }),
  archivePath: Schema.String.annotate({
    description: "Where to write the produced .xcarchive, e.g. 'build/App.xcarchive'",
  }),
  extraArgs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional raw arguments appended to the xcodebuild invocation",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

// Shared metadata shape across every execute() return path (invalid args, spawn failure, archive
// outcome) — Tool.define infers execute()'s return type from its first `return`, so every branch
// must satisfy one common type rather than each narrowing independently.
export type XcodeArchiveMeta = {
  ok: boolean
  status: "invalid_args" | "spawn_failed" | "archive_failed" | "archive_succeeded"
  error?: string
  errorCount?: number
  warningCount?: number
  archivePath?: string
  rawLogPath?: string
  durationMs?: number
}

/** Build the `xcodebuild archive` argv from tool params. Only includes flags that were provided. */
export function buildArchiveArgs(params: Params): string[] {
  const args = ["archive", "-scheme", params.scheme]
  if (params.workspace) args.push("-workspace", params.workspace)
  if (params.project) args.push("-project", params.project)
  if (params.configuration) args.push("-configuration", params.configuration)
  args.push("-archivePath", params.archivePath)
  if (params.extraArgs) args.push(...params.extraArgs)
  return args
}

export const XcodeArchiveTool = Tool.define(
  "xcode_archive",
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
          const title = `xcodebuild archive: ${params.scheme}`

          // Reject an escaping archivePath, or path-escaping/blast-radius-widening extraArgs,
          // BEFORE prompting for permission or spawning xcodebuild: this is a hard
          // input-validation failure, not something a permission grant should be able to bless.
          // See xcode-argv.ts for both the extraArgs denylist and the path-param check.
          const pathError = validatePath(params.archivePath, cwd)
          const argvError = pathError ?? validateExtraArgs(params.extraArgs)
          if (argvError) {
            const metadata: XcodeArchiveMeta = { ok: false, status: "invalid_args", error: argvError }
            return { title, output: JSON.stringify(metadata), metadata }
          }

          yield* ctx.ask({
            permission: "xcode_archive",
            patterns: [params.scheme],
            always: [params.scheme],
            metadata: { scheme: params.scheme, workspace: params.workspace, project: params.project },
          })

          const start = Date.now()
          const args = buildArchiveArgs(params)

          const outcome = yield* runXcodebuild(
            spawner,
            trunc,
            new StreamingXcodeParser(undefined, SUCCESS_MARKER, FAIL_MARKER),
            {
              args,
              cwd,
              timeoutMs: ARCHIVE_TIMEOUT_MS,
              toolLabel: "xcode_archive",
              sinkErrorNote: "raw log write failed (disk full or permission denied); diagnostics above are complete",
            },
          )
          const durationMs = Date.now() - start

          if (outcome.spawnFailed) {
            // Distinct from an archive failure: the toolchain/process never produced diagnostics.
            const summary = {
              ok: false,
              status: "spawn_failed" as const,
              error: outcome.error,
              durationMs,
            }
            const metadata: XcodeArchiveMeta = { ok: false, status: "spawn_failed", error: outcome.error, durationMs }
            return { title, output: JSON.stringify(summary), metadata }
          }

          const parsed = outcome.parser.result(outcome.exitCode)
          const status = parsed.ok ? ("archive_succeeded" as const) : ("archive_failed" as const)

          const summary = {
            ok: parsed.ok,
            status,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            errors: parsed.errors,
            warnings: parsed.warnings,
            ...(parsed.ok ? { archivePath: params.archivePath } : {}),
            ...(parsed.errorTruncated || parsed.warningTruncated
              ? { truncated: { errors: parsed.errorTruncated, warnings: parsed.warningTruncated } }
              : {}),
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            ...(outcome.parser.tailTruncated() ? { rawLogTruncated: true } : {}),
            ...(outcome.rawLogNote ? { rawLogNote: outcome.rawLogNote } : {}),
            durationMs,
          }

          const metadata: XcodeArchiveMeta = {
            ok: parsed.ok,
            status,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            ...(parsed.ok ? { archivePath: params.archivePath } : {}),
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            durationMs,
          }
          return { title, output: JSON.stringify(summary), metadata }
        }),
    }
  }),
)
