// kilocode_change - new file
import crypto from "node:crypto"
import type { AscCredential } from "./auth"

const ASC_AUDIENCE = "appstoreconnect-v1"
const EXPIRY_SECONDS = 1200 // 20 minutes - the maximum App Store Connect allows

type Header = {
  alg: "ES256"
  kid: string
  typ: "JWT"
}

type Claims = {
  iss: string
  iat: number
  exp: number
  aud: typeof ASC_AUDIENCE
}

function b64url(value: Header | Claims): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

/**
 * Parse the credential's `.p8` PEM into a `KeyObject`, without ever surfacing the PEM content in
 * a thrown error. Node's own `createPrivateKey` error messages are OpenSSL/decoder diagnostics
 * (they don't echo the input), but we still throw a fresh, deliberately generic message here so
 * the security guarantee does not depend on Node's internal error formatting staying that way.
 */
function parsePrivateKey(privateKeyPem: string): crypto.KeyObject {
  try {
    return crypto.createPrivateKey(privateKeyPem)
  } catch {
    throw new Error(
      "signAscJwt: the configured App Store Connect private key is not a valid PEM-encoded EC private key",
    )
  }
}

/**
 * Hand-rolled ES256 JWT signer for the App Store Connect API (node:crypto only, no jwt library).
 * Builds the header/claims ASC requires, then signs with a raw IEEE P1363 (R‖S) ECDSA signature -
 * NOT the DER encoding `crypto.sign` produces by default for EC keys.
 *
 * `opts.now` (ms epoch) is injectable for deterministic tests; defaults to `Date.now()`.
 *
 * SECURITY: never logs or returns `cred.privateKeyPem`; the only string this function returns is
 * the signed token itself.
 */
export function signAscJwt(cred: AscCredential, opts?: { now?: number }): string {
  const iat = Math.floor((opts?.now ?? Date.now()) / 1000)
  const header: Header = { alg: "ES256", kid: cred.keyId, typ: "JWT" }
  const claims: Claims = { iss: cred.issuerId, iat, exp: iat + EXPIRY_SECONDS, aud: ASC_AUDIENCE }

  const signingInput = `${b64url(header)}.${b64url(claims)}`
  const key = parsePrivateKey(cred.privateKeyPem)
  const signature = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" })

  return `${signingInput}.${signature.toString("base64url")}`
}
