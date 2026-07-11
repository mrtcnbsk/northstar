// kilocode_change - new file
import { describe, expect, test, beforeAll } from "bun:test"
import crypto from "node:crypto"
import { signAscJwt } from "../../../src/kilocode/asc/jwt"

const FIXED = 1_700_000_000_000 // fixed ms timestamp for deterministic iat/exp

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
}

describe("signAscJwt", () => {
  let privateKeyPem: string
  let publicKey: crypto.KeyObject

  beforeAll(() => {
    const { privateKey, publicKey: pub } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
    privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    publicKey = pub
  })

  test("produces a 3-part base64url token", () => {
    const token = signAscJwt({ issuerId: "ISS", keyId: "KID", privateKeyPem }, { now: FIXED })
    const parts = token.split(".")
    expect(parts).toHaveLength(3)
  })

  test("header decodes to the expected ES256 JWT header", () => {
    const token = signAscJwt({ issuerId: "ISS", keyId: "KID", privateKeyPem }, { now: FIXED })
    const [headerPart] = token.split(".")
    expect(b64urlJson(headerPart)).toEqual({ alg: "ES256", kid: "KID", typ: "JWT" })
  })

  test("claims decode to the expected ASC claim set with a 20-minute expiry", () => {
    const token = signAscJwt({ issuerId: "ISS", keyId: "KID", privateKeyPem }, { now: FIXED })
    const [, claimsPart] = token.split(".")
    const iat = Math.floor(FIXED / 1000)
    expect(b64urlJson(claimsPart)).toEqual({
      iss: "ISS",
      iat,
      exp: iat + 1200,
      aud: "appstoreconnect-v1",
    })
  })

  test("the signature verifies against the matching public key with ieee-p1363 encoding", () => {
    const token = signAscJwt({ issuerId: "ISS", keyId: "KID", privateKeyPem }, { now: FIXED })
    const [headerPart, claimsPart, sigPart] = token.split(".")
    const signingInput = `${headerPart}.${claimsPart}`
    const sigBytes = Buffer.from(sigPart, "base64url")

    const ok = crypto.verify(
      "sha256",
      Buffer.from(signingInput),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      sigBytes,
    )
    expect(ok).toBe(true)
  })

  test("a malformed PEM throws a clear error that never echoes the key material", () => {
    const malformed = "not-a-real-pem-key-material-xyz123"
    expect(() => signAscJwt({ issuerId: "ISS", keyId: "KID", privateKeyPem: malformed }, { now: FIXED })).toThrow()

    try {
      signAscJwt({ issuerId: "ISS", keyId: "KID", privateKeyPem: malformed }, { now: FIXED })
      throw new Error("expected signAscJwt to throw")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain(malformed)
      expect(message.toLowerCase()).not.toContain("begin")
    }
  })
})
