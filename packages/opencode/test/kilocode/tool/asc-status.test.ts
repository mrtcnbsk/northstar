// kilocode_change - new file
import { describe, expect, spyOn } from "bun:test"
import crypto from "node:crypto"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { AscStatusTool } from "../../../src/kilocode/tool/asc-status"
import * as AscAuth from "../../../src/kilocode/asc/auth"
import type { AscCredential } from "../../../src/kilocode/asc/auth"
import { MessageID, SessionID } from "../../../src/session/schema"
import { testEffect } from "../../lib/effect"

const harness = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Truncate.defaultLayer, Config.defaultLayer, Agent.defaultLayer),
)

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "code",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function fakeCredential(): AscCredential {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    issuerId: "ISS-SECRET-ID",
    keyId: "KID-SECRET-ID",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}

type Call = { url: string; method: string; body: unknown }

function routeFetch(overrides: { onCall?: (call: Call) => Response | undefined } = {}) {
  const calls: Call[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)

    const override = overrides.onCall?.(call)
    if (override) return override

    if (call.url.includes("/v1/apps?filter")) {
      return new Response(
        JSON.stringify({ data: [{ id: "app-1", attributes: { bundleId: "com.example.app", name: "Example" } }] }),
        { status: 200 },
      )
    }
    if (call.url.includes("/v1/apps/app-1/appStoreVersions") && call.method === "GET") {
      return new Response(
        JSON.stringify({
          data: [{ id: "ver-1", attributes: { versionString: "1.2.0", appStoreState: "IN_REVIEW" } }],
        }),
        { status: 200 },
      )
    }
    if (call.url.includes("/v1/appStoreVersions/ver-1")) {
      return new Response(JSON.stringify({ data: { attributes: { appStoreState: "IN_REVIEW" } } }), { status: 200 })
    }
    throw new Error(`unexpected fetch in test: ${call.method} ${call.url}`)
  }) as typeof fetch
  return { calls, impl }
}

const runExecute = (params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* AscStatusTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  })

describe("AscStatusTool: no credential configured", () => {
  harness.instance("returns the clean unavailable message, metadata.unavailable:true, never throws", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(undefined)
      try {
        const result = yield* runExecute({ version_id: "ver-1" })
        expect(result.output).toContain("App Store Connect delivery unavailable")
        expect(result.metadata.unavailable).toBe(true)
      } finally {
        cred.mockRestore()
      }
    }),
  )
})

// kilocode_change start - finding #2: loadAscCredential can REJECT (e.g. a corrupt auth.json ->
// JSON.parse defect -> the underlying Effect runPromise rejects), not just resolve to undefined.
// Before the fix, asc-status.ts awaited it via `Effect.promise` - which assumes the promise never
// rejects - so a rejection became an unrecovered Effect defect and the tool threw a raw error
// (risking a leaked auth.json path) instead of degrading to the same clean "unavailable" message a
// missing credential produces. This must degrade identically to the "no credential" case above.
describe("AscStatusTool: corrupt/unreadable auth store (loadAscCredential REJECTS, not just undefined)", () => {
  harness.instance(
    "a rejecting loadAscCredential degrades to the clean unavailable message, metadata.unavailable:true, never throws, no auth path leaked",
    () =>
      Effect.gen(function* () {
        const cred = spyOn(AscAuth, "loadAscCredential").mockImplementation(() =>
          Promise.reject(new Error("ENOENT: no such file or directory, open '/Users/x/.local/share/opencode/auth.json'")),
        )
        try {
          const result = yield* runExecute({ version_id: "ver-1" })
          expect(result.output).toContain("App Store Connect delivery unavailable")
          expect(result.metadata.unavailable).toBe(true)

          // SECURITY: the underlying rejection's message (which could contain a filesystem path)
          // must never leak into the tool's output.
          expect(result.output).not.toContain("auth.json")
          expect(result.output).not.toContain("ENOENT")
        } finally {
          cred.mockRestore()
        }
      }),
  )
})
// kilocode_change end

describe("AscStatusTool: with an injected credential + fake fetch", () => {
  harness.instance("version_id given directly reads the state with a single GET, no bundle lookup", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const { calls, impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute({ version_id: "ver-1" })
        const summary = JSON.parse(result.output)
        expect(summary.state).toBe("IN_REVIEW")
        expect(summary.versionId).toBe("ver-1")
        expect(result.metadata.state).toBe("IN_REVIEW")
        expect(calls).toHaveLength(1)
        expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1")
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("bundle_id + version resolves the app and version first, then reads the state", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const { calls, impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute({ bundle_id: "com.example.app", version: "1.2.0" })
        const summary = JSON.parse(result.output)
        expect(summary.state).toBe("IN_REVIEW")
        expect(summary.versionId).toBe("ver-1")
        expect(calls.some((c) => c.url.includes("/v1/apps?filter[bundleId]=com.example.app"))).toBe(true)
        expect(calls.some((c) => c.url.includes("/v1/apps/app-1/appStoreVersions"))).toBe(true)
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("neither version_id nor bundle_id+version -> structured error, never throws", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        (async (..._args: Parameters<typeof fetch>) => {
          throw new Error("must not call fetch")
        }) as unknown as typeof fetch,
      )
      try {
        const result = yield* runExecute({})
        const summary = JSON.parse(result.output)
        expect(typeof summary.error).toBe("string")
        expect(result.metadata.state).toBeUndefined()
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("a 4xx from App Store Connect maps to a structured error, not a thrown Response", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        (async (..._args: Parameters<typeof fetch>) =>
          new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND", title: "Not Found" }] }), {
            status: 404,
          })) as typeof fetch,
      )
      try {
        const result = yield* runExecute({ version_id: "missing" })
        const summary = JSON.parse(result.output)
        expect(summary.error).toContain("Not Found")
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("SECURITY: the credential is never echoed in the output", () =>
    Effect.gen(function* () {
      const credential = fakeCredential()
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(credential)
      const { impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute({ version_id: "ver-1" })
        expect(result.output).not.toContain(credential.privateKeyPem)
        expect(result.output).not.toContain(credential.issuerId)
        expect(result.output).not.toContain(credential.keyId)
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )
})
