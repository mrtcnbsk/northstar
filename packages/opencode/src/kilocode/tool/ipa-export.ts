// kilocode_change - new file
import { Effect, Schema } from "effect"
import { readdirSync } from "node:fs"
import path from "node:path"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "@/tool/truncate"
import { validateExtraArgs, validatePath } from "./xcode-argv"
import { StreamingXcodeParser, runXcodebuild } from "./xcodebuild-exec"
import DESCRIPTION from "./ipa-export.txt"

// Exports are normally much faster than a build/archive, but a large archive (many app
// extensions, on-demand-resources) can still take a while — mirrors xcode_build's budget so a
// slow export is not mistaken for a hang.
export const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

const SUCCESS_MARKER = "** EXPORT SUCCEEDED **"
const FAIL_MARKER = "** EXPORT FAILED **"

export const Params = Schema.Struct({
  archivePath: Schema.String.annotate({ description: "Path to the .xcarchive produced by xcode_archive" }),
  exportOptionsPlist: Schema.String.annotate({
    description: "Path to an ExportOptions.plist describing how to export (method, signing, etc.)",
  }),
  exportPath: Schema.String.annotate({ description: "Directory to write the exported .ipa (and manifest) into" }),
  extraArgs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional raw arguments appended to the xcodebuild invocation",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

// Shared metadata shape across every execute() return path (invalid args, spawn failure, export
// outcome) — Tool.define infers execute()'s return type from its first `return`, so every branch
// must satisfy one common type rather than each narrowing independently.
export type IpaExportMeta = {
  ok: boolean
  status: "invalid_args" | "spawn_failed" | "export_failed" | "export_succeeded"
  error?: string
  errorCount?: number
  warningCount?: number
  ipaPaths?: string[]
  rawLogPath?: string
  durationMs?: number
}

/** Build the `xcodebuild -exportArchive` argv from tool params. */
export function buildExportArgs(params: Params): string[] {
  const args = [
    "-exportArchive",
    "-archivePath",
    params.archivePath,
    "-exportOptionsPlist",
    params.exportOptionsPlist,
    "-exportPath",
    params.exportPath,
  ]
  if (params.extraArgs) args.push(...params.extraArgs)
  return args
}

/** List the `.ipa` file(s) produced under `exportDir` (resolved, absolute). Never throws — a
 * missing/unreadable directory just yields no paths, since the structured `errors[]`/`warnings[]`
 * from the parsed xcodebuild output remain the authoritative signal for what went wrong. */
export function listIpaFiles(exportDir: string): string[] {
  try {
    return readdirSync(exportDir)
      .filter((entry) => entry.toLowerCase().endsWith(".ipa"))
      .sort()
      .map((entry) => path.join(exportDir, entry))
  } catch {
    return []
  }
}

export const IpaExportTool = Tool.define(
  "ipa_export",
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
          const title = "xcodebuild -exportArchive"

          // Reject an escaping archivePath/exportOptionsPlist/exportPath, or path-escaping/
          // blast-radius-widening extraArgs, BEFORE prompting for permission or spawning
          // xcodebuild: this is a hard input-validation failure, not something a permission grant
          // should be able to bless. See xcode-argv.ts for both checks.
          const pathError =
            validatePath(params.archivePath, cwd) ??
            validatePath(params.exportOptionsPlist, cwd) ??
            validatePath(params.exportPath, cwd)
          const argvError = pathError ?? validateExtraArgs(params.extraArgs)
          if (argvError) {
            const metadata: IpaExportMeta = { ok: false, status: "invalid_args", error: argvError }
            return { title, output: JSON.stringify(metadata), metadata }
          }

          yield* ctx.ask({
            permission: "ipa_export",
            patterns: ["*"],
            always: ["*"],
            metadata: { archivePath: params.archivePath, exportPath: params.exportPath },
          })

          const start = Date.now()
          const args = buildExportArgs(params)

          const outcome = yield* runXcodebuild(
            spawner,
            trunc,
            new StreamingXcodeParser(undefined, SUCCESS_MARKER, FAIL_MARKER),
            {
              args,
              cwd,
              timeoutMs: EXPORT_TIMEOUT_MS,
              toolLabel: "ipa_export",
              sinkErrorNote: "raw log write failed (disk full or permission denied); diagnostics above are complete",
            },
          )
          const durationMs = Date.now() - start

          if (outcome.spawnFailed) {
            // Distinct from an export failure: the toolchain/process never produced diagnostics.
            const summary = {
              ok: false,
              status: "spawn_failed" as const,
              error: outcome.error,
              durationMs,
            }
            const metadata: IpaExportMeta = { ok: false, status: "spawn_failed", error: outcome.error, durationMs }
            return { title, output: JSON.stringify(summary), metadata }
          }

          const parsed = outcome.parser.result(outcome.exitCode)
          const status = parsed.ok ? ("export_succeeded" as const) : ("export_failed" as const)
          const ipaPaths = parsed.ok ? listIpaFiles(path.resolve(cwd, params.exportPath)) : []

          const summary = {
            ok: parsed.ok,
            status,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            errors: parsed.errors,
            warnings: parsed.warnings,
            ...(parsed.ok ? { ipaPaths } : {}),
            ...(parsed.errorTruncated || parsed.warningTruncated
              ? { truncated: { errors: parsed.errorTruncated, warnings: parsed.warningTruncated } }
              : {}),
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            ...(outcome.parser.tailTruncated() ? { rawLogTruncated: true } : {}),
            ...(outcome.rawLogNote ? { rawLogNote: outcome.rawLogNote } : {}),
            durationMs,
          }

          const metadata: IpaExportMeta = {
            ok: parsed.ok,
            status,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            ...(parsed.ok ? { ipaPaths } : {}),
            ...(outcome.rawLogPath ? { rawLogPath: outcome.rawLogPath } : {}),
            durationMs,
          }
          return { title, output: JSON.stringify(summary), metadata }
        }),
    }
  }),
)
