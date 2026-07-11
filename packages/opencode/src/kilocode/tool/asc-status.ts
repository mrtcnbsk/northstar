// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import * as AscAuth from "@/kilocode/asc/auth"
import { AscClient, AscError } from "@/kilocode/asc/client"
import { getAppByBundleId, ensureAppStoreVersion, getReviewState } from "@/kilocode/asc/operations"
import DESCRIPTION from "./asc-status.txt"

const UNAVAILABLE_MESSAGE =
  "App Store Connect delivery unavailable: no credential configured. Set your ASC API key (issuer id + key id + .p8) via the auth store or ASC_ISSUER_ID/ASC_KEY_ID/ASC_KEY_PATH env vars."

export const Params = Schema.Struct({
  bundle_id: Schema.optional(Schema.String).annotate({
    description: "The app's bundle identifier, e.g. com.example.app. Combine with `version` to resolve a versionId.",
  }),
  version: Schema.optional(Schema.String).annotate({
    description: "The App Store version string, e.g. 1.2.0. Required alongside `bundle_id` when `version_id` is not given directly.",
  }),
  version_id: Schema.optional(Schema.String).annotate({
    description: "The App Store Connect appStoreVersions id, e.g. as returned by asc_submit. Takes precedence over bundle_id/version when given.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

// Shared metadata shape across every execute() return path — Tool.define infers execute()'s
// return type from its first `return`, so every branch must satisfy one common type.
export type AscStatusMeta = {
  unavailable?: boolean
  error?: string
  state?: string
  versionId?: string
}

function describeError(err: unknown): string {
  if (err instanceof AscError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

/** Resolve the target `versionId`: `version_id` directly when given, else `bundle_id` + `version`
 * via `getAppByBundleId` + `ensureAppStoreVersion` (find-or-create — idempotent, the same
 * resolution step `asc_submit` performs; by the time status is checked the version normally
 * already exists, so in practice this only ever finds). Throws a plain Error (never an AscError
 * with credential material) when the app can't be resolved or params are insufficient. */
async function resolveVersionId(client: AscClient, params: Params): Promise<string> {
  if (params.version_id) return params.version_id
  if (params.bundle_id && params.version) {
    const app = await getAppByBundleId(client, params.bundle_id)
    if (!app) throw new Error(`no App Store Connect app found for bundle id "${params.bundle_id}"`)
    const version = await ensureAppStoreVersion(client, app.id, params.version)
    return version.id
  }
  throw new Error("either version_id, or bundle_id and version, must be provided")
}

export const AscStatusTool = Tool.define(
  "asc_status",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Params,
    execute: (params: Params, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const title = "asc_status"

        yield* ctx.ask({
          permission: "asc_status",
          patterns: [params.bundle_id ?? params.version_id ?? "*"],
          always: ["*"],
          metadata: { bundleId: params.bundle_id, version: params.version, versionId: params.version_id },
        })

        // SECURITY: `credential` (and its `.p8` PEM) is NEVER included in any output/log below.
        const credential = yield* Effect.promise(() => AscAuth.loadAscCredential())
        if (!credential) {
          const metadata: AscStatusMeta = { unavailable: true }
          return { title, output: UNAVAILABLE_MESSAGE, metadata }
        }

        const client = new AscClient({ credential })

        const attempt = yield* Effect.tryPromise({
          try: async () => {
            const versionId = await resolveVersionId(client, params)
            const state = await getReviewState(client, versionId)
            return { versionId, state }
          },
          catch: (e) => e,
        }).pipe(
          Effect.match({
            onFailure: (e) => ({ ok: false as const, error: describeError(e) }),
            onSuccess: (v) => ({ ok: true as const, value: v }),
          }),
        )

        if (!attempt.ok) {
          const metadata: AscStatusMeta = { error: attempt.error }
          return { title, output: JSON.stringify({ error: attempt.error }), metadata }
        }

        const { versionId, state } = attempt.value
        const metadata: AscStatusMeta = { state, versionId }
        return { title, output: JSON.stringify({ state, versionId }), metadata }
      }),
  }),
)
