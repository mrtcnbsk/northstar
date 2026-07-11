// kilocode_change - new file
import { describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { Effect, Layer, Stream } from "effect"
import { ChildProcessSpawner, ChildProcess } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { AscSubmitTool } from "../../../src/kilocode/tool/asc-submit"
import * as AscAuth from "../../../src/kilocode/asc/auth"
import type { AscCredential } from "../../../src/kilocode/asc/auth"
import type { MetadataEntry } from "../../../src/kilocode/tool/asc-metadata-validate"
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

function noSpawner() {
  // Never expected to be invoked in tests that don't pass ipa_path — fails loudly if it is.
  return ChildProcessSpawner.make(() => Effect.die("spawner should not be invoked without ipa_path"))
}

function fakeHandle(all: ChildProcessSpawner.ChildProcessHandle["all"], exit = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

type Call = { url: string; method: string; body: unknown }

/** Routes a fake `globalThis.fetch` across the sequence of ASC JSON-API calls asc_submit makes
 * (getAppByBundleId -> ensureAppStoreVersion -> createReviewSubmission -> submitForReview),
 * recording every call for assertions. Mirrors operations.test.ts's fixture shape but keyed by
 * URL/method since asc_submit drives several endpoints in one flow. */
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
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }
    if (call.url === "https://api.appstoreconnect.apple.com/v1/appStoreVersions") {
      return new Response(
        JSON.stringify({ data: { id: "ver-1", attributes: { versionString: "1.2.0", appStoreState: "PREPARE_FOR_SUBMISSION" } } }),
        { status: 201 },
      )
    }
    if (call.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissions" && call.method === "POST") {
      return new Response(JSON.stringify({ data: { id: "rs-1", attributes: { state: "READY_FOR_REVIEW" } } }), {
        status: 201,
      })
    }
    if (call.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems") {
      return new Response(JSON.stringify({ data: { id: "item-1" } }), { status: 201 })
    }
    if (call.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissions/rs-1" && call.method === "PATCH") {
      return new Response(JSON.stringify({ data: { id: "rs-1", attributes: { state: "WAITING_FOR_REVIEW" } } }), {
        status: 200,
      })
    }
    throw new Error(`unexpected fetch in test: ${call.method} ${call.url}`)
  }) as typeof fetch
  return { calls, impl }
}

const baseEntry: MetadataEntry = {
  locale: "en-US",
  name: "Keel",
  subtitle: "Cash flow copilot",
  promotionalText: "See your money, decide fast.",
  keywords: "budget,finance,ledger",
  description: "An on-device cash-flow copilot that never leaves your phone.",
}

const runExecute = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  params: Record<string, unknown> = { bundle_id: "com.example.app", version: "1.2.0" },
) =>
  Effect.gen(function* () {
    const info = yield* AscSubmitTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("AscSubmitTool: no credential configured", () => {
  harness.instance("returns the clean unavailable message, metadata.unavailable:true, never throws", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(undefined)
      try {
        const result = yield* runExecute(noSpawner())
        expect(result.output).toContain("App Store Connect delivery unavailable")
        expect(result.output).toContain("configure")
        expect(result.metadata.unavailable).toBe(true)
        expect(result.metadata.submitted).toBe(false)
      } finally {
        cred.mockRestore()
      }
    }),
  )
})

// kilocode_change start - finding #2: loadAscCredential can REJECT (e.g. a corrupt auth.json ->
// JSON.parse defect -> the underlying Effect runPromise rejects), not just resolve to undefined.
// Before the fix, asc-submit.ts awaited it via `Effect.promise` - which assumes the promise never
// rejects - so a rejection became an unrecovered Effect defect and the tool threw a raw error
// (risking a leaked auth.json path) instead of degrading to the same clean "unavailable" message a
// missing credential produces. This must degrade identically to the "no credential" case above.
describe("AscSubmitTool: corrupt/unreadable auth store (loadAscCredential REJECTS, not just undefined)", () => {
  harness.instance(
    "a rejecting loadAscCredential degrades to the clean unavailable message, metadata.unavailable:true, never throws, no auth path leaked",
    () =>
      Effect.gen(function* () {
        const cred = spyOn(AscAuth, "loadAscCredential").mockImplementation(() =>
          Promise.reject(new Error("ENOENT: no such file or directory, open '/Users/x/.local/share/opencode/auth.json'")),
        )
        try {
          const result = yield* runExecute(noSpawner())
          expect(result.output).toContain("App Store Connect delivery unavailable")
          expect(result.output).toContain("configure")
          expect(result.metadata.unavailable).toBe(true)
          expect(result.metadata.submitted).toBe(false)

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

describe("AscSubmitTool: full submit flow with an injected credential + fake fetch", () => {
  harness.instance("builds the right ASC calls (version ensured, submitted) and returns {submitted:true, versionId}", () =>
    Effect.gen(function* () {
      const credential = fakeCredential()
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(credential)
      const { calls, impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute(noSpawner())
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(true)
        expect(summary.versionId).toBe("ver-1")
        expect(summary.appId).toBe("app-1")
        expect(result.metadata.submitted).toBe(true)
        expect(result.metadata.versionId).toBe("ver-1")

        expect(calls.some((c) => c.url.includes("/v1/apps?filter[bundleId]=com.example.app"))).toBe(true)
        expect(calls.some((c) => c.method === "POST" && c.url === "https://api.appstoreconnect.apple.com/v1/appStoreVersions")).toBe(true)
        expect(calls.some((c) => c.method === "POST" && c.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissions")).toBe(true)
        expect(calls.some((c) => c.method === "PATCH" && c.url.includes("/v1/reviewSubmissions/rs-1"))).toBe(true)

        // SECURITY: never echo the credential/key in output, in any form.
        expect(result.output).not.toContain(credential.privateKeyPem)
        expect(result.output).not.toContain(credential.issuerId)
        expect(result.output).not.toContain(credential.keyId)
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("testflight_only stops after resolving the app; never creates a version or submits", () =>
    Effect.gen(function* () {
      const credential = fakeCredential()
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(credential)
      const { calls, impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute(noSpawner(), {
          bundle_id: "com.example.app",
          version: "1.2.0",
          testflight_only: true,
        })
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(false)
        expect(summary.testflight).toBe(true)
        expect(summary.appId).toBe("app-1")
        expect(calls).toHaveLength(1) // only getAppByBundleId
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("an unresolvable bundle id surfaces as a structured {submitted:false, error}, never a throw", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
        (async (..._args: Parameters<typeof fetch>) =>
          new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch,
      )
      try {
        const result = yield* runExecute(noSpawner())
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(false)
        expect(typeof summary.error).toBe("string")
        expect(summary.error).toContain("com.example.app")
        expect(result.metadata.submitted).toBe(false)
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
        const result = yield* runExecute(noSpawner())
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(false)
        expect(summary.error).toContain("Not Found")
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )
})

describe("AscSubmitTool: metadata validation blocks submission", () => {
  harness.instance("an over-limit metadata field blocks submission with a clear message; no ASC call is made", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const { calls, impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute(noSpawner(), {
          bundle_id: "com.example.app",
          version: "1.2.0",
          metadata: [{ ...baseEntry, name: "a".repeat(31) }],
        })
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(false)
        expect(summary.blocked).toBe(true)
        expect(summary.violations.some((v: any) => v.field === "name")).toBe(true)
        expect(result.metadata.blocked).toBe(true)
        expect(calls).toHaveLength(0) // never reached App Store Connect
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("valid inline metadata does not block submission (metadataValidated:true)", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const { impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      try {
        const result = yield* runExecute(noSpawner(), {
          bundle_id: "com.example.app",
          version: "1.2.0",
          metadata: [baseEntry],
        })
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(true)
        expect(summary.metadataValidated).toBe(true)
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )
})

describe("AscSubmitTool: ipa_path upload via xcrun altool (fake ChildProcessSpawner)", () => {
  harness.instance("a successful altool upload proceeds to the ASC submission flow", () =>
    Effect.gen(function* () {
      const credential = fakeCredential()
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(credential)
      const { impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      let spawnedCommand: string | undefined
      let spawnedArgs: readonly string[] = []
      const spawner = ChildProcessSpawner.make((cmd) => {
        const std = ChildProcess.isStandardCommand(cmd) ? cmd : undefined
        spawnedCommand = std?.command
        spawnedArgs = std?.args ?? []
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      try {
        const result = yield* runExecute(spawner, {
          bundle_id: "com.example.app",
          version: "1.2.0",
          ipa_path: "build/App.ipa",
        })
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(true)
        expect(summary.buildUploaded).toBe(true)

        // The altool invocation: identifiers only (keyId/issuerId) — never the private key.
        expect(spawnedCommand).toBe("xcrun")
        expect(spawnedArgs).toEqual([
          "altool",
          "--upload-app",
          "-f",
          "build/App.ipa",
          "-t",
          "ios",
          "--apiKey",
          credential.keyId,
          "--apiIssuer",
          credential.issuerId,
        ])
        for (const arg of spawnedArgs) expect(arg).not.toContain(credential.privateKeyPem)
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("a failed altool upload blocks submission with a structured error; ASC is never called", () =>
    Effect.gen(function* () {
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(fakeCredential())
      const { calls, impl } = routeFetch()
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(impl)
      const encoder = new TextEncoder()
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(fakeHandle(Stream.make(encoder.encode("Error: Unable to authenticate.")), 1)),
      )
      try {
        const result = yield* runExecute(spawner, {
          bundle_id: "com.example.app",
          version: "1.2.0",
          ipa_path: "build/App.ipa",
        })
        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(false)
        expect(summary.error).toContain("altool")
        expect(calls).toHaveLength(0) // never reached App Store Connect
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )

  harness.instance("a '..'-traversal ipa_path is rejected before permission/credential work; spawner never invoked", () =>
    Effect.gen(function* () {
      let spawnCalled = false
      const spawner = ChildProcessSpawner.make(() => {
        spawnCalled = true
        return Effect.succeed(fakeHandle(Stream.empty, 0))
      })
      const result = yield* runExecute(spawner, {
        bundle_id: "com.example.app",
        version: "1.2.0",
        ipa_path: "../../etc/App.ipa",
      })
      const summary = JSON.parse(result.output)
      expect(summary.submitted).toBe(false)
      expect(summary.blocked).toBe(true)
      expect(spawnCalled).toBe(false)
    }),
  )
})
