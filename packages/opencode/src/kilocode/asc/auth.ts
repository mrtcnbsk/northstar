// kilocode_change - new file
import fs from "node:fs"
import { Auth } from "@/auth"
import { makeRuntime } from "@/effect/run-service"

/**
 * The complete App Store Connect API credential: an issuer id, a key id, and the `.p8` private
 * key PEM. All three are required to build an ASC API JWT (see `asc/jwt.ts`).
 *
 * SECURITY: `privateKeyPem` is secret material. It must never be logged, thrown in an error
 * message, or written to any committed file. It lives only in the out-of-repo auth store
 * (`Global.Path.data/auth.json`, 0o600) or in the user's local environment - see `resolveAscAuth`.
 */
export type AscCredential = {
  issuerId: string
  keyId: string
  privateKeyPem: string
}

const PROVIDER_ID = "appstore-connect"

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * Read the `.p8` PEM from `ASC_PRIVATE_KEY` (inline) or, failing that, from the file path in
 * `ASC_KEY_PATH`. A missing/unreadable file resolves to `undefined` rather than throwing - the
 * caller-visible signal for "no credential configured" is always `resolveAscAuth` returning
 * `undefined`, never a thrown error (which could otherwise leak filesystem details).
 */
function envPrivateKeyPem(env: NodeJS.ProcessEnv): string | undefined {
  const inline = text(env.ASC_PRIVATE_KEY)
  if (inline) return inline

  const keyPath = text(env.ASC_KEY_PATH)
  if (!keyPath) return undefined

  try {
    return text(fs.readFileSync(keyPath, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * PURE precedence resolver for the App Store Connect credential, mirroring
 * `resolveKiloIndexingAuth`'s multi-source precedence shape. Per field, the out-of-repo auth
 * store beats the environment:
 *
 *   issuerId:      auth.metadata.issuerId  -> env.ASC_ISSUER_ID
 *   keyId:         auth.metadata.keyId     -> env.ASC_KEY_ID
 *   privateKeyPem: auth.key                -> env.ASC_PRIVATE_KEY (inline) -> file at env.ASC_KEY_PATH
 *
 * `config` is accepted only for interface parity with `resolveKiloIndexingAuth` - it is
 * intentionally NEVER read for credential material. Per the public-repo security rule, the ASC
 * key must live only in the out-of-repo auth store or env vars, never in `.kilo/`,
 * `organization.jsonc`, or any other committed config surface.
 *
 * Returns the complete `AscCredential` triple, or `undefined` if any of the three fields is
 * missing - callers should show a "configure your App Store Connect API key" message in that case.
 * This function never throws and never includes the PEM in any error path.
 */
export function resolveAscAuth(input: {
  config?: unknown
  auth?: { key?: string; metadata?: Record<string, string> } | undefined
  env?: NodeJS.ProcessEnv
}): AscCredential | undefined {
  const auth = input.auth
  const env = input.env ?? process.env

  const issuerId = text(auth?.metadata?.issuerId) ?? text(env.ASC_ISSUER_ID)
  const keyId = text(auth?.metadata?.keyId) ?? text(env.ASC_KEY_ID)
  const privateKeyPem = text(auth?.key) ?? envPrivateKeyPem(env)

  if (!issuerId || !keyId || !privateKeyPem) return undefined
  return { issuerId, keyId, privateKeyPem }
}

const authRuntime = makeRuntime(Auth.Service, Auth.defaultLayer)

/**
 * Thin loader mirroring `indexing.ts`'s `kiloAuth`: reads the `"appstore-connect"` record from
 * the real out-of-repo auth store, then resolves it (with env fallback) via the pure
 * `resolveAscAuth`. Use this from tools/CLI code; use `resolveAscAuth` directly in tests.
 */
export async function loadAscCredential(): Promise<AscCredential | undefined> {
  const info = await authRuntime.runPromise((svc) => svc.get(PROVIDER_ID))
  const auth = info?.type === "api" ? { key: info.key, metadata: info.metadata } : undefined
  return resolveAscAuth({ auth, env: process.env })
}
