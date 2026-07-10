// kilocode_change - new file
import { Effect, Schema, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as Truncate from "@/tool/truncate"
import DESCRIPTION from "./xcode-build.txt"

// Builds can legitimately run long (clean builds, large workspaces, CI-grade schemes).
// 10 minutes is generous enough to avoid false timeouts while still bounding a single
// build attempt inside a build-loop budget.
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000

// Bound the number of parsed diagnostics returned to the model. xcodebuild can emit
// thousands of lines; the raw log (rawLogPath) remains available for full detail.
export const MAX_DIAGNOSTICS = 100

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

type Meta = {
  ok: boolean
  errorCount: number
  warningCount: number
  rawLogPath: string
  durationMs: number
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

          yield* ctx.ask({
            permission: "xcode_build",
            patterns: [params.scheme ?? "*"],
            always: [params.scheme ?? "*"],
            metadata: { scheme: params.scheme, workspace: params.workspace, project: params.project },
          })

          const start = Date.now()
          const command = ChildProcess.make("xcodebuild", args, { cwd, stdin: "ignore" })
          const { raw, exitCode } = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(command)
              let text = ""
              const drain = Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
                Effect.sync(() => {
                  text += chunk
                }),
              )
              const timeout = Effect.sleep(`${BUILD_TIMEOUT_MS} millis`)
              const race = yield* Effect.raceAll([
                Effect.all([handle.exitCode, drain], { concurrency: 2 }).pipe(
                  Effect.map(([code]) => ({ kind: "exit" as const, code: Number(code) })),
                ),
                timeout.pipe(Effect.as({ kind: "timeout" as const, code: 1 })),
              ])
              if (race.kind === "timeout") {
                yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
                text += `\n\n[xcode_build] terminated after exceeding timeout ${BUILD_TIMEOUT_MS} ms`
              }
              return { raw: text, exitCode: race.code }
            }),
          ).pipe(Effect.catch(() => Effect.succeed({ raw: "", exitCode: 1 })))
          const durationMs = Date.now() - start

          const parsed = parseXcodebuildOutput(raw, exitCode)
          const rawLogPath = yield* trunc.write(raw)

          const summary = {
            ok: parsed.ok,
            errorCount: parsed.errors.length,
            warningCount: parsed.warnings.length,
            errors: parsed.errors,
            warnings: parsed.warnings,
            ...(parsed.errorTruncated || parsed.warningTruncated
              ? { truncated: { errors: parsed.errorTruncated, warnings: parsed.warningTruncated } }
              : {}),
            rawLogPath,
            durationMs,
          }

          return {
            title: params.scheme ? `xcodebuild: ${params.scheme}` : "xcodebuild",
            output: JSON.stringify(summary),
            metadata: {
              ok: parsed.ok,
              errorCount: parsed.errors.length,
              warningCount: parsed.warnings.length,
              rawLogPath,
              durationMs,
            },
          }
        }),
    }
  }),
)
