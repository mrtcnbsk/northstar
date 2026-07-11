// kilocode_change - new file
import { Effect, Schema, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ChildProcess } from "effect/unstable/process"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import * as AscAuth from "@/kilocode/asc/auth"
import { AscClient, AscError } from "@/kilocode/asc/client"
import { getAppByBundleId, ensureAppStoreVersion, createReviewSubmission, submitForReview } from "@/kilocode/asc/operations"
import { validateAscMetadata, MetadataEntry } from "./asc-metadata-validate"
import { validatePath } from "./xcode-argv"
import DESCRIPTION from "./asc-submit.txt"

// The clean, no-credential message every ASC-facing tool degrades to. Never a throw, never a
// stack trace — see loadAscCredential's own doc comment for why (a missing key must never surface
// filesystem/auth-store details, only "go configure one").
const UNAVAILABLE_MESSAGE =
  "App Store Connect delivery unavailable: no credential configured. Set your ASC API key (issuer id + key id + .p8) via the auth store or ASC_ISSUER_ID/ASC_KEY_ID/ASC_KEY_PATH env vars."

export const Params = Schema.Struct({
  bundle_id: Schema.String.annotate({ description: "The app's bundle identifier, e.g. com.example.app" }),
  version: Schema.String.annotate({ description: "The App Store version string to submit, e.g. 1.2.0" }),
  ipa_path: Schema.optional(Schema.String).annotate({
    description:
      "Path to the .ipa produced by ipa_export. When given, it is uploaded to App Store Connect via `xcrun altool --upload-app` BEFORE the JSON-API metadata/submission calls run.",
  }),
  testflight_only: Schema.optional(Schema.Boolean).annotate({
    description: "Stop after the TestFlight build upload; do not create an App Store version or submit for review.",
  }),
  metadata: Schema.optional(Schema.Array(MetadataEntry)).annotate({
    description:
      "Locale metadata entries to validate before submitting (same shape as asc_metadata_validate's `entries`). A violation blocks submission with no ASC call made.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

// Shared metadata shape across every execute() return path — Tool.define infers execute()'s
// return type from its first `return`, so every branch must satisfy one common type.
export type AscSubmitMeta = {
  submitted: boolean
  unavailable?: boolean
  blocked?: boolean
  testflight?: boolean
  versionId?: string
  appId?: string
  error?: string
}

type AltoolUploadResult = { ok: boolean; error?: string }

/**
 * Upload a build binary to App Store Connect via `xcrun altool --upload-app`. This is the ONE
 * part of the delivery flow that is NOT a JSON-API call (see operations.ts's module doc comment
 * on the binary-upload split) — it is a child-process spawn, mirroring xcode_archive/ipa_export's
 * use of the shared `ChildProcessSpawner`.
 *
 * `--apiKey`/`--apiIssuer` pass the key id / issuer id (both identifiers, not secret material) so
 * altool knows WHICH credential to use; altool itself then reads the actual `.p8` private key from
 * disk at the Apple-documented discovery path `~/.appstoreconnect/private_keys/AuthKey_<keyId>.p8`
 * — the private key content is NEVER passed as a CLI argument and NEVER appears in this function's
 * output. See asc-submit.txt for the full key-discovery requirement.
 *
 * Never throws: a spawn failure (altool/xcrun missing) is caught and reported as `{ok: false}`,
 * exactly like a nonzero exit — the caller cannot tell the two apart from this result alone, which
 * is fine since both mean "the upload did not happen" and the message says why.
 */
function runAltoolUpload(
  spawner: ChildProcessSpawner["Service"],
  args: { ipaPath: string; keyId: string; issuerId: string },
  cwd: string,
): Effect.Effect<AltoolUploadResult> {
  const argv = [
    "altool",
    "--upload-app",
    "-f",
    args.ipaPath,
    "-t",
    "ios",
    "--apiKey",
    args.keyId,
    "--apiIssuer",
    args.issuerId,
  ]
  const cmd = ChildProcess.make("xcrun", argv, { cwd, stdin: "ignore" })

  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(cmd)
      let tail = ""
      const MAX_TAIL = 4000
      yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
        Effect.sync(() => {
          tail += chunk
          if (tail.length > MAX_TAIL) tail = tail.slice(tail.length - MAX_TAIL)
        }),
      )
      const exitCode = Number(yield* handle.exitCode)
      if (exitCode === 0) return { ok: true }
      return { ok: false, error: tail.trim() || `xcrun altool exited with code ${exitCode}` }
    }),
  ).pipe(Effect.catch((e) => Effect.succeed({ ok: false, error: e instanceof Error ? e.message : String(e) })))
}

/** Describe a caught error for the model-facing output. `AscError`'s own `.message` is already
 * built from ASC's `{errors:[...]}` envelope (status/code/title/detail) — never the credential —
 * so this never needs (and must never attempt) to read `AscCredential` fields. */
function describeError(err: unknown): string {
  if (err instanceof AscError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

type SubmissionOutcome = {
  submitted: boolean
  testflight: boolean
  appId: string
  versionId?: string
  reviewState?: string
}

/** The JSON-API side of the flow (everything after a build is optionally already on ASC), thin
 * wrappers over operations.ts so it stays fixture-testable with an injected `fetch` on `client`. */
async function runSubmission(
  client: AscClient,
  params: { bundle_id: string; version: string; testflight_only?: boolean },
): Promise<SubmissionOutcome> {
  const app = await getAppByBundleId(client, params.bundle_id)
  if (!app) {
    throw new Error(`no App Store Connect app found for bundle id "${params.bundle_id}"`)
  }
  if (params.testflight_only) {
    return { submitted: false, testflight: true, appId: app.id }
  }
  const version = await ensureAppStoreVersion(client, app.id, params.version)
  const submission = await createReviewSubmission(client, app.id)
  const submitted = await submitForReview(client, submission.id, version.id)
  return { submitted: true, testflight: false, appId: app.id, versionId: version.id, reviewState: submitted.state }
}

export const AscSubmitTool = Tool.define(
  "asc_submit",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner

    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const cwd = instance.directory
          const title = `asc_submit: ${params.bundle_id} ${params.version}`

          // Path-param validation BEFORE permission/credential work, mirroring xcode_archive/
          // ipa_export: an escaping ipa_path is a hard input error, not something a permission
          // grant or a configured credential should be able to bless.
          if (params.ipa_path) {
            const pathError = validatePath(params.ipa_path, cwd)
            if (pathError) {
              const metadata: AscSubmitMeta = { submitted: false, blocked: true, error: pathError }
              return { title, output: JSON.stringify({ submitted: false, blocked: true, error: pathError }), metadata }
            }
          }

          yield* ctx.ask({
            permission: "asc_submit",
            patterns: [params.bundle_id],
            always: [params.bundle_id],
            metadata: { bundleId: params.bundle_id, version: params.version, testflightOnly: params.testflight_only },
          })

          // SECURITY: `credential` (and its `.p8` PEM) is NEVER included in any output/log below —
          // only `AscClient`/`runAltoolUpload` ever see it, and neither echoes it back.
          const credential = yield* Effect.promise(() => AscAuth.loadAscCredential())
          if (!credential) {
            const metadata: AscSubmitMeta = { submitted: false, unavailable: true }
            return { title, output: UNAVAILABLE_MESSAGE, metadata }
          }

          if (params.metadata) {
            const validated = validateAscMetadata(params.metadata)
            if (!validated.ok) {
              const summary = {
                submitted: false,
                blocked: true,
                reason: "metadata validation failed",
                violations: validated.violations,
              }
              const metadata: AscSubmitMeta = { submitted: false, blocked: true, error: "metadata validation failed" }
              return { title, output: JSON.stringify(summary), metadata }
            }
          }

          const client = new AscClient({ credential })

          if (params.ipa_path) {
            const upload = yield* runAltoolUpload(
              spawner,
              { ipaPath: params.ipa_path, keyId: credential.keyId, issuerId: credential.issuerId },
              cwd,
            )
            if (!upload.ok) {
              const error = `xcrun altool upload failed: ${upload.error}`
              const summary = { submitted: false, error }
              const metadata: AscSubmitMeta = { submitted: false, error }
              return { title, output: JSON.stringify(summary), metadata }
            }
          }

          const attempt = yield* Effect.tryPromise({
            try: () => runSubmission(client, params),
            catch: (e) => e,
          }).pipe(Effect.match({ onFailure: (e) => ({ ok: false as const, error: describeError(e) }), onSuccess: (v) => ({ ok: true as const, value: v }) }))

          if (!attempt.ok) {
            const summary = { submitted: false, error: attempt.error }
            const metadata: AscSubmitMeta = { submitted: false, error: attempt.error }
            return { title, output: JSON.stringify(summary), metadata }
          }

          const outcome = attempt.value
          const summary = {
            submitted: outcome.submitted,
            testflight: outcome.testflight,
            appId: outcome.appId,
            ...(outcome.versionId ? { versionId: outcome.versionId } : {}),
            ...(outcome.reviewState ? { reviewState: outcome.reviewState } : {}),
            ...(params.metadata ? { metadataValidated: true } : {}),
            ...(params.ipa_path ? { buildUploaded: true } : {}),
          }
          const metadata: AscSubmitMeta = {
            submitted: outcome.submitted,
            testflight: outcome.testflight,
            versionId: outcome.versionId,
            appId: outcome.appId,
          }
          return { title, output: JSON.stringify(summary), metadata }
        }),
    }
  }),
)
