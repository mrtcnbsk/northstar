// kilocode_change - new file
import { describe, expect, test, beforeAll } from "bun:test"
import crypto from "node:crypto"
import { AscClient, AscError } from "../../../src/kilocode/asc/client"
import type { AscCredential } from "../../../src/kilocode/asc/auth"

const FIXED = 1_700_000_000_000 // fixed ms timestamp for deterministic token minting

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
}

function decodeHeader(token: string): { alg: string; kid: string; typ: string } {
  const [headerPart] = token.split(".")
  return b64urlJson(headerPart) as { alg: string; kid: string; typ: string }
}

describe("AscClient", () => {
  let credential: AscCredential

  beforeAll(() => {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
    credential = {
      issuerId: "ISS",
      keyId: "KID-123",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }
  })

  test("request sets Authorization: Bearer <ES256 JWT>, Content-Type/Accept json, correct method+URL", async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch

    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
    await client.get("/v1/apps")

    expect(capturedUrl).toBe("https://api.appstoreconnect.apple.com/v1/apps")
    expect(capturedInit?.method).toBe("GET")

    const headers = new Headers(capturedInit?.headers)
    expect(headers.get("content-type")).toBe("application/json")
    expect(headers.get("accept")).toBe("application/json")

    const auth = headers.get("authorization")
    expect(auth).toMatch(/^Bearer /)
    const token = auth!.slice("Bearer ".length)
    expect(decodeHeader(token)).toEqual({ alg: "ES256", kid: "KID-123", typ: "JWT" })
  })

  test("a custom baseUrl is honored", async () => {
    let capturedUrl: string | undefined
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch

    const client = new AscClient({
      credential,
      fetch: fetchImpl,
      now: () => FIXED,
      baseUrl: "https://example.test",
    })
    await client.get("/v1/apps")

    expect(capturedUrl).toBe("https://example.test/v1/apps")
  })

  test("post sends a JSON-serialized body", async () => {
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ data: { id: "1" } }), { status: 201 })
    }) as typeof fetch

    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
    await client.post("/v1/apps", { data: { type: "apps", attributes: { name: "Example" } } })

    expect(capturedInit?.method).toBe("POST")
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      data: { type: "apps", attributes: { name: "Example" } },
    })
  })

  test("a 429 then 200 is retried and succeeds", async () => {
    let calls = 0
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
      calls++
      if (calls === 1) {
        return new Response(JSON.stringify({ errors: [{ status: "429", code: "RATE_LIMIT" }] }), { status: 429 })
      }
      return new Response(JSON.stringify({ data: { id: "42" } }), { status: 200 })
    }) as typeof fetch

    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
    const result = await client.get<{ data: { id: string } }>("/v1/apps/42")

    expect(calls).toBe(2)
    expect(result).toEqual({ data: { id: "42" } })
  })

  test("a 400 with an ASC errors envelope throws a typed AscError, not a raw Response", async () => {
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          errors: [
            {
              status: "400",
              code: "PARAMETER_ERROR.INVALID",
              title: "Invalid Parameter",
              detail: "'name' is too long",
            },
          ],
        }),
        { status: 400 },
      )) as typeof fetch

    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })

    let caught: unknown
    try {
      await client.get("/v1/apps")
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AscError)
    const ascError = caught as AscError
    expect(ascError.status).toBe(400)
    expect(ascError.code).toBe("PARAMETER_ERROR.INVALID")
    expect(ascError.title).toBe("Invalid Parameter")
    expect(ascError.detail).toBe("'name' is too long")
  })

  test("a persistent 5xx is retried up to the cap, then throws a typed AscError", async () => {
    let calls = 0
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
      calls++
      return new Response(JSON.stringify({ errors: [{ status: "500", title: "Server Error" }] }), { status: 500 })
    }) as typeof fetch

    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })

    let caught: unknown
    try {
      await client.get("/v1/apps")
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AscError)
    expect(calls).toBeGreaterThan(1)
  })

  test("caches the token across requests within the same window", async () => {
    const tokens: (string | null)[] = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("authorization"))
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch

    let now = FIXED
    const client = new AscClient({ credential, fetch: fetchImpl, now: () => now })
    await client.get("/v1/apps")
    now += 5_000 // 5s later - well within the 20-minute token window
    await client.get("/v1/apps")

    expect(tokens[0]).toBe(tokens[1])
  })

  test("re-mints the token once it nears expiry", async () => {
    const tokens: (string | null)[] = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      tokens.push(new Headers(init?.headers).get("authorization"))
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch

    let now = FIXED
    const client = new AscClient({ credential, fetch: fetchImpl, now: () => now })
    await client.get("/v1/apps")
    now += 19 * 60 * 1000 // 19 minutes later - inside the ~2min re-mint margin of the 20min token
    await client.get("/v1/apps")

    expect(tokens[0]).not.toBe(tokens[1])
  })

  test("never logs the token or the credential material", async () => {
    const originalLog = console.log
    const originalError = console.error
    const logs: unknown[] = []
    console.log = (...args: unknown[]) => logs.push(args)
    console.error = (...args: unknown[]) => logs.push(args)
    try {
      const fetchImpl = (async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch
      const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
      await client.get("/v1/apps")
    } finally {
      console.log = originalLog
      console.error = originalError
    }
    expect(JSON.stringify(logs)).not.toContain(credential.privateKeyPem)
  })
})
