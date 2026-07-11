// kilocode_change - new file
import { describe, expect, test, afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { resolveAscAuth } from "../../../src/kilocode/asc/auth"

const AUTH_STORE_PEM = "-----BEGIN PRIVATE KEY-----\nAUTHSTOREPEMCONTENT\n-----END PRIVATE KEY-----\n"
const ENV_INLINE_PEM = "-----BEGIN PRIVATE KEY-----\nENVINLINEPEMCONTENT\n-----END PRIVATE KEY-----\n"
const ENV_FILE_PEM = "-----BEGIN PRIVATE KEY-----\nENVFILEPEMCONTENT\n-----END PRIVATE KEY-----\n"

const tmpFiles: string[] = []

function writeTempKeyFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-test-asc-auth-"))
  const file = path.join(dir, "AuthKey.p8")
  fs.writeFileSync(file, content, "utf8")
  tmpFiles.push(dir)
  return file
}

afterAll(() => {
  for (const dir of tmpFiles) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("resolveAscAuth", () => {
  test("resolves the full triple from the auth-store Api record", () => {
    const result = resolveAscAuth({
      auth: { key: AUTH_STORE_PEM, metadata: { issuerId: "iss-store", keyId: "kid-store" } },
    })

    // privateKeyPem is trimmed of surrounding whitespace (mirrors resolveKiloIndexingAuth's
    // `text()` normalization) - harmless for crypto.createPrivateKey, which ignores outer
    // whitespace around a PEM block.
    expect(result).toEqual({ issuerId: "iss-store", keyId: "kid-store", privateKeyPem: AUTH_STORE_PEM.trim() })
  })

  test("resolves the full triple from env vars only (inline ASC_PRIVATE_KEY)", () => {
    const result = resolveAscAuth({
      env: { ASC_ISSUER_ID: "iss-env", ASC_KEY_ID: "kid-env", ASC_PRIVATE_KEY: ENV_INLINE_PEM },
    })

    expect(result).toEqual({ issuerId: "iss-env", keyId: "kid-env", privateKeyPem: ENV_INLINE_PEM.trim() })
  })

  test("resolves the private key from the file at ASC_KEY_PATH when ASC_PRIVATE_KEY is absent", () => {
    const keyPath = writeTempKeyFile(ENV_FILE_PEM)
    const result = resolveAscAuth({
      env: { ASC_ISSUER_ID: "iss-file", ASC_KEY_ID: "kid-file", ASC_KEY_PATH: keyPath },
    })

    expect(result).toEqual({ issuerId: "iss-file", keyId: "kid-file", privateKeyPem: ENV_FILE_PEM.trim() })
  })

  test("the auth store beats env when both are present", () => {
    const result = resolveAscAuth({
      auth: { key: AUTH_STORE_PEM, metadata: { issuerId: "iss-store", keyId: "kid-store" } },
      env: { ASC_ISSUER_ID: "iss-env", ASC_KEY_ID: "kid-env", ASC_PRIVATE_KEY: ENV_INLINE_PEM },
    })

    expect(result).toEqual({ issuerId: "iss-store", keyId: "kid-store", privateKeyPem: AUTH_STORE_PEM.trim() })
  })

  test("returns undefined when issuerId is missing", () => {
    const result = resolveAscAuth({
      env: { ASC_KEY_ID: "kid-env", ASC_PRIVATE_KEY: ENV_INLINE_PEM },
    })

    expect(result).toBeUndefined()
  })

  test("returns undefined when keyId is missing", () => {
    const result = resolveAscAuth({
      env: { ASC_ISSUER_ID: "iss-env", ASC_PRIVATE_KEY: ENV_INLINE_PEM },
    })

    expect(result).toBeUndefined()
  })

  test("returns undefined when the private key is missing (no ASC_PRIVATE_KEY, no ASC_KEY_PATH)", () => {
    const result = resolveAscAuth({
      env: { ASC_ISSUER_ID: "iss-env", ASC_KEY_ID: "kid-env" },
    })

    expect(result).toBeUndefined()
  })

  test("returns undefined when nothing is configured at all", () => {
    const result = resolveAscAuth({ env: {} })
    expect(result).toBeUndefined()
  })

  test("returns undefined (not a throw) when ASC_KEY_PATH points at a nonexistent file", () => {
    const result = resolveAscAuth({
      env: {
        ASC_ISSUER_ID: "iss-env",
        ASC_KEY_ID: "kid-env",
        ASC_KEY_PATH: "/tmp/does-not-exist-asc-key-path.p8",
      },
    })

    expect(result).toBeUndefined()
  })

  test("never includes the PEM in a thrown message when resolution fails", () => {
    let threw = false
    try {
      resolveAscAuth({
        env: {
          ASC_ISSUER_ID: "iss-env",
          ASC_KEY_ID: "kid-env",
          ASC_KEY_PATH: "/tmp/does-not-exist-asc-key-path.p8",
        },
      })
    } catch (err) {
      threw = true
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain(AUTH_STORE_PEM)
      expect(message).not.toContain(ENV_INLINE_PEM)
      expect(message).not.toContain(ENV_FILE_PEM)
    }
    // resolveAscAuth must never throw - missing/unreadable key material is signaled by `undefined`
    expect(threw).toBe(false)
  })
})
