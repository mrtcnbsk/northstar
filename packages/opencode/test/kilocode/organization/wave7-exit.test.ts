// kilocode_change - new file
// Wave 7 exit criteria made executable (fixture-tested, no live creds): archive→IPA, ES256 JWT
// auth, ASC ops + metadata gate, review monitor, human-gated delivery stage, graceful
// no-credential degradation.
//
// Wave 7 gave the org a BYO-Apple-credentials delivery pipeline (W7.1-W7.6): archive → IPA export
// → validate marketing metadata → (with the user's own App Store Connect API key) submit for
// review, monitored to a terminal state, all sitting behind a human-gated `delivery` pipeline
// stage. This file proves the WHOLE "idea → App Store" chain end to end at the fixture level -
// NOT ONE live Apple call, NOT ONE real credential, anywhere in this file - by reusing every
// harness the individual Wave-7 unit-test files already built rather than inventing new infra:
//   - xcode-archive.test.ts / ipa-export.test.ts's fake `ChildProcessSpawner` + captured
//     `** ARCHIVE/EXPORT SUCCEEDED **` log fixtures, for criterion 1.
//   - jwt.test.ts / client.test.ts's in-test EC P-256 keypair (a synthetic `.p8`) + injected
//     `fetch`, for criteria 2 and 3.
//   - operations.test.ts's canned-ASC-JSON fake-fetch idiom, for criterion 3.
//   - review-monitor.test.ts's scripted fake-fetch client + `TestClock`-driven fiber, for
//     criterion 4.
//   - wave5-exit.test.ts / wave6-exit.test.ts's `OrgRunner.start/advance/decide` + `tmpdir` +
//     `writeDeliverable` runner-drive idiom (and `batch-adapter.ts`'s `advance1`), for criterion 5.
//   - asc-submit.test.ts / asc-status.test.ts's `spyOn(AscAuth, "loadAscCredential")` + `Tool.init()`
//     harness, for criteria 6 and 7.
//
// Criterion 7 is deliberately NOT a happy-path fake: it documents a real, current gap (see the
// `// TODO(W7-followup)` comment on it) rather than asserting behavior the shipped code doesn't
// have yet.
import { describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Layer, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { XcodeArchiveTool } from "../../../src/kilocode/tool/xcode-archive"
import { IpaExportTool } from "../../../src/kilocode/tool/ipa-export"
import { AscSubmitTool } from "../../../src/kilocode/tool/asc-submit"
import { AscStatusTool } from "../../../src/kilocode/tool/asc-status"
import { validateAscMetadata } from "../../../src/kilocode/tool/asc-metadata-validate"
import { signAscJwt } from "../../../src/kilocode/asc/jwt"
import { AscClient } from "../../../src/kilocode/asc/client"
import { resolveAscAuth, type AscCredential } from "../../../src/kilocode/asc/auth"
import * as AscAuth from "../../../src/kilocode/asc/auth"
import { getAppByBundleId, ensureAppStoreVersion, createReviewSubmission, submitForReview } from "../../../src/kilocode/asc/operations"
import { reviewMonitorLoop, type ReviewStateChange } from "../../../src/kilocode/asc/review-monitor"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { advance1 } from "./batch-adapter"
import { tmpdir, TestInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const FIXED = 1_700_000_000_000 // fixed ms timestamp for deterministic JWT iat/exp across sections

// ---- shared Tool.execute() harness (criteria 1, 6, 7) -------------------------------------------
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

const encoder = new TextEncoder()

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

// asc_status never spawns; asc_submit only spawns when `ipa_path` is given (not the case in
// criteria 6/7 below) - a spawner that dies loudly if invoked catches a wiring mistake instantly.
function noSpawner() {
  return ChildProcessSpawner.make(() => Effect.die("spawner should not be invoked in this test"))
}

const runXcodeArchive = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* XcodeArchiveTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

const runIpaExport = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* IpaExportTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

const runAscSubmit = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* AscSubmitTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

const runAscStatus = (params: Record<string, unknown>) =>
  Effect.gen(function* () {
    const info = yield* AscStatusTool
    const tool = yield* info.init()
    return yield* tool.execute(params as any, baseCtx as any)
  })

const ARCHIVE_SUCCEEDED_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild archive -workspace Keel.xcworkspace -scheme Keel -archivePath build/Keel.xcarchive

** ARCHIVE SUCCEEDED **
`

const EXPORT_SUCCEEDED_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild -exportArchive -archivePath build/Keel.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath build/export

** EXPORT SUCCEEDED **
`

function freshEcCredential(issuerId: string, keyId: string): { credential: AscCredential; publicKey: crypto.KeyObject } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    credential: { issuerId, keyId, privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() },
    publicKey,
  }
}

describe("Wave 7 exit verification", () => {
  // --- 1. Build artifact: xcode_archive -> archivePath, then ipa_export -> the produced .ipa. ---
  harness.instance(
    "1. build artifact: xcode_archive succeeds on a fixture '** ARCHIVE SUCCEEDED **' log, then ipa_export succeeds and reports the produced .ipa path",
    () =>
      Effect.gen(function* () {
        const archiveSpawner = ChildProcessSpawner.make(() =>
          Effect.succeed(fakeHandle(Stream.make(encoder.encode(ARCHIVE_SUCCEEDED_FIXTURE)), 0)),
        )
        const archiveResult = yield* runXcodeArchive(archiveSpawner, {
          scheme: "Keel",
          archivePath: "build/Keel.xcarchive",
        })
        const archiveSummary = JSON.parse(archiveResult.output)
        expect(archiveSummary.status).toBe("archive_succeeded")
        expect(archiveSummary.ok).toBe(true)
        expect(archiveSummary.archivePath).toBe("build/Keel.xcarchive")

        // xcodebuild itself would produce the .ipa on a real export; the fake spawner only
        // supplies the success LOG, so - mirroring ipa-export.test.ts - the test seeds the file
        // ipa_export is expected to discover under exportPath.
        const test = yield* TestInstance
        const exportDir = path.join(test.directory, "build", "export")
        mkdirSync(exportDir, { recursive: true })
        writeFileSync(path.join(exportDir, "Keel.ipa"), "")

        const exportSpawner = ChildProcessSpawner.make(() =>
          Effect.succeed(fakeHandle(Stream.make(encoder.encode(EXPORT_SUCCEEDED_FIXTURE)), 0)),
        )
        const exportResult = yield* runIpaExport(exportSpawner, {
          // chains off the archive's own reported archivePath, proving archive -> export flows.
          archivePath: archiveSummary.archivePath,
          exportOptionsPlist: "ExportOptions.plist",
          exportPath: "build/export",
        })
        const exportSummary = JSON.parse(exportResult.output)
        expect(exportSummary.status).toBe("export_succeeded")
        expect(exportSummary.ok).toBe(true)
        expect(exportSummary.ipaPaths).toEqual([path.join(exportDir, "Keel.ipa")])
      }),
  )

  // --- 2. Auth -> JWT: signAscJwt is ES256/kid and verifies; AscClient attaches it as Bearer. ---
  test("2. auth -> JWT: signAscJwt produces an ES256/kid token whose signature verifies, and AscClient attaches the matching token as Bearer on a request", async () => {
    const { credential, publicKey } = freshEcCredential("ISS-EXIT", "KID-EXIT")

    const directToken = signAscJwt(credential, { now: FIXED })
    const [directHeader, directClaims, directSig] = directToken.split(".")
    expect(JSON.parse(Buffer.from(directHeader, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: "KID-EXIT",
      typ: "JWT",
    })
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${directHeader}.${directClaims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(directSig, "base64url"),
      ),
    ).toBe(true)

    let capturedAuth: string | null = null
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      capturedAuth = new Headers(init?.headers).get("authorization")
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch
    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
    await client.get("/v1/apps")

    expect(capturedAuth).toMatch(/^Bearer /)
    const attachedToken = capturedAuth!.slice("Bearer ".length)
    const [attachedHeader, attachedClaims, attachedSig] = attachedToken.split(".")
    // Same credential + same `now` -> identical header/claims (deterministic JSON + base64url);
    // the ECDSA signature itself may legitimately differ byte-for-byte between two signing calls
    // (P-256 signing is randomized, not RFC-6979 deterministic) so it is verified independently
    // below rather than compared for byte equality against `directSig`.
    expect(attachedHeader).toBe(directHeader)
    expect(attachedClaims).toBe(directClaims)
    expect(
      crypto.verify(
        "sha256",
        Buffer.from(`${attachedHeader}.${attachedClaims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(attachedSig, "base64url"),
      ),
    ).toBe(true)
  })

  // --- 3. ASC ops + metadata gate. ---
  test("3. ASC ops + metadata gate: getAppByBundleId -> ensureAppStoreVersion -> createReviewSubmission -> submitForReview build the correct request shapes; validateAscMetadata blocks an over-limit name and passes a valid set", async () => {
    const { credential } = freshEcCredential("ISS-EXIT", "KID-EXIT")
    type Call = { url: string; method: string; body: unknown }
    const calls: Call[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      }
      calls.push(call)
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
          JSON.stringify({
            data: { id: "ver-1", attributes: { versionString: "1.2.0", appStoreState: "PREPARE_FOR_SUBMISSION" } },
          }),
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
    const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })

    const app = await getAppByBundleId(client, "com.example.app")
    expect(app).toEqual({ id: "app-1", bundleId: "com.example.app", name: "Example" })

    const version = await ensureAppStoreVersion(client, app!.id, "1.2.0")
    expect(version).toEqual({ id: "ver-1", versionString: "1.2.0", appStoreState: "PREPARE_FOR_SUBMISSION" })

    const submission = await createReviewSubmission(client, app!.id)
    const submitted = await submitForReview(client, submission.id, version.id)
    expect(submitted).toEqual({ id: "rs-1", state: "WAITING_FOR_REVIEW" })

    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=com.example.app",
    })
    expect(calls.some((c) => c.method === "POST" && c.url === "https://api.appstoreconnect.apple.com/v1/appStoreVersions")).toBe(true)
    expect(calls.some((c) => c.method === "POST" && c.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissions")).toBe(true)
    expect(calls.some((c) => c.method === "POST" && c.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems")).toBe(true)
    expect(calls.some((c) => c.method === "PATCH" && c.url === "https://api.appstoreconnect.apple.com/v1/reviewSubmissions/rs-1")).toBe(true)

    // The metadata gate: an over-limit name (31 code points; ASC's limit is 30) is a violation.
    const overLimit = validateAscMetadata([
      { locale: "en-US", name: "a".repeat(31), description: "An on-device cash-flow copilot that never leaves your phone." },
    ])
    expect(overLimit.ok).toBe(false)
    expect(overLimit.violations.some((v) => v.field === "name" && v.locale === "en-US")).toBe(true)

    // A fully valid entry set within every limit passes clean.
    const valid = validateAscMetadata([
      {
        locale: "en-US",
        name: "Keel",
        subtitle: "Cash flow copilot",
        promotionalText: "See your money, decide fast.",
        keywords: "budget,finance,ledger",
        description: "An on-device cash-flow copilot that never leaves your phone.",
      },
    ])
    expect(valid).toEqual({ ok: true, violations: [] })
  })

  // --- 4. Review monitor: reviewMonitorLoop polls, publishes transitions, resolves terminal. ---
  describe("4. review monitor: reviewMonitorLoop (TestClock-driven, scripted fake fetch) publishes state transitions and resolves at the terminal state", () => {
    const monitorHarness = testEffect(Layer.empty)

    function scriptedClient(script: string[]) {
      const { credential } = freshEcCredential("ISS-EXIT", "KID-EXIT")
      let call = 0
      const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
        const index = Math.min(call, script.length - 1)
        call++
        return new Response(
          JSON.stringify({ data: { id: "ver-exit", attributes: { appStoreState: script[index] } } }),
          { status: 200 },
        )
      }) as typeof fetch
      return new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
    }

    // Repeatedly advances TestClock by small steps and yields, letting the loop's fetch ->
    // response.text() -> JSON.parse promise chain settle between advances (verbatim idiom from
    // review-monitor.test.ts's `driveToCompletion`, reproduced here rather than imported since
    // that helper is local/unexported there).
    const driveToCompletion = <A, E>(fiber: Fiber.Fiber<A, E>, stepMs = 50, maxSteps = 2000) =>
      Effect.gen(function* () {
        for (let i = 0; i < maxSteps; i++) {
          if (fiber.pollUnsafe() !== undefined) break
          yield* TestClock.adjust(stepMs)
          yield* Effect.yieldNow
        }
        return yield* Fiber.join(fiber)
      })

    monitorHarness.effect("WAITING_FOR_REVIEW -> IN_REVIEW -> READY_FOR_SALE: 2 published transitions, resolves READY_FOR_SALE", () =>
      Effect.gen(function* () {
        const client = scriptedClient(["WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_SALE"])
        const captured: ReviewStateChange[] = []
        const fiber = yield* reviewMonitorLoop({
          client,
          versionId: "ver-exit",
          pollMs: 1000,
          deadlineMs: 600_000,
          publish: (change) => Effect.sync(() => captured.push(change)),
        }).pipe(Effect.forkChild)

        const result = yield* driveToCompletion(fiber)

        expect(result).toBe("READY_FOR_SALE")
        expect(captured).toEqual([
          { versionId: "ver-exit", from: "WAITING_FOR_REVIEW", to: "IN_REVIEW" },
          { versionId: "ver-exit", from: "IN_REVIEW", to: "READY_FOR_SALE" },
        ])
      }),
    )

    monitorHarness.effect("a second run, WAITING_FOR_REVIEW -> IN_REVIEW -> REJECTED: 2 published transitions, resolves REJECTED", () =>
      Effect.gen(function* () {
        const client = scriptedClient(["WAITING_FOR_REVIEW", "IN_REVIEW", "REJECTED"])
        const captured: ReviewStateChange[] = []
        const fiber = yield* reviewMonitorLoop({
          client,
          versionId: "ver-exit-2",
          pollMs: 1000,
          deadlineMs: 600_000,
          publish: (change) => Effect.sync(() => captured.push(change)),
        }).pipe(Effect.forkChild)

        const result = yield* driveToCompletion(fiber)

        expect(result).toBe("REJECTED")
        expect(captured).toEqual([
          { versionId: "ver-exit-2", from: "WAITING_FOR_REVIEW", to: "IN_REVIEW" },
          { versionId: "ver-exit-2", from: "IN_REVIEW", to: "REJECTED" },
        ])
      }),
    )
  })

  // --- 5. Delivery gate (runner): the human-gated `delivery` pipeline stage. ---
  test("5. delivery gate (runner): the delivery stage reaches awaiting_approval AFTER marketing settles; a no-go HALTS the run (delivery is never re-instructed to submit); an approve lets it proceed", async () => {
    // Same shape as the shipped org-template (org-template/organization.jsonc's W7.6 delivery
    // dept/stage): plan -> marketing -> delivery(requires:["marketing"], gate:"human",
    // haltOn:"no-go"), delivery terminal.
    const DELIVERY_ORG = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        plan: { chief: "plan-chief", workers: ["architect"] },
        marketing: { chief: "mkt-chief", workers: ["copywriter"] },
        delivery: { chief: "delivery-chief", workers: ["release-engineer"] },
      },
      shared: ["apple-docs"],
      pipeline: [
        { stage: "plan" },
        { stage: "marketing", requires: ["plan"] },
        { stage: "delivery", requires: ["marketing"], gate: "human", haltOn: "no-go" },
      ],
    })
    const deps = { costOf: async () => 1 }

    async function writeDeliverable(dir: string, runID: string, stage: string) {
      const file = OrgArtifacts.deliverablePath(dir, runID, stage)
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
    }

    // --- no-go path: the gate holds, then halts; delivery is never given another chance to run. ---
    {
      await using tmp = await tmpdir()
      const run = await OrgRunner.start(tmp.path, DELIVERY_ORG, "wave7 exit idea - no-go path")

      const b1 = await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, {})
      expect(b1.instruct.map((i) => i.stage)).toEqual(["plan"])
      await writeDeliverable(tmp.path, run.runID, "plan")

      const b2 = await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, { taskID: "ses_plan" })
      expect(b2.instruct.map((i) => i.stage)).toEqual(["marketing"])
      await writeDeliverable(tmp.path, run.runID, "marketing")

      // marketing settles -> delivery (requires marketing, now satisfied) is instructed. Gate not
      // reached yet: delivery's OWN gate only fires once ITS chief task settles (same mechanic as
      // wave5-exit.test.ts's review gate).
      const b3 = await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, { taskID: "ses_mkt" })
      expect(b3.instruct.map((i) => i.stage)).toEqual(["delivery"])
      await writeDeliverable(tmp.path, run.runID, "delivery")

      const gated = await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, { taskID: "ses_delivery" })
      expect(gated.gate).toMatchObject({ stage: "delivery" })
      expect(gated.instruct).toEqual([])

      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["marketing"].status).toBe("completed") // gate reached AFTER marketing
      expect(state.stages["delivery"].status).toBe("awaiting_approval")

      const decided = await OrgRunner.decide(
        tmp.path,
        DELIVERY_ORG,
        run.runID,
        "no-go",
        "release-engineer flagged an unreviewed metadata change",
      )
      expect(decided.status).toBe("halted")
      expect(decided.haltReason).toContain("no-go at delivery")
      expect(decided.haltReason).toContain("release-engineer flagged an unreviewed metadata change")

      // The headline guarantee: once halted, a subsequent advance NEVER re-instructs delivery -
      // whatever chief prompt would actually call asc_submit for real never runs again.
      const after = await advance1(deps, tmp.path, DELIVERY_ORG, run.runID, {})
      expect(after.kind).toBe("halted")

      const finalStatus = await OrgRunner.status(tmp.path, DELIVERY_ORG, run.runID)
      expect(finalStatus.run.status).toBe("halted")
    }

    // --- approve path: a clean run's gate lets delivery (the terminal stage) complete the run. ---
    {
      await using tmp = await tmpdir()
      const run = await OrgRunner.start(tmp.path, DELIVERY_ORG, "wave7 exit idea - approve path")

      await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, {})
      await writeDeliverable(tmp.path, run.runID, "plan")
      await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, { taskID: "ses_plan" })
      await writeDeliverable(tmp.path, run.runID, "marketing")
      await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, { taskID: "ses_mkt" })
      await writeDeliverable(tmp.path, run.runID, "delivery")

      const gated = await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, { taskID: "ses_delivery" })
      expect(gated.gate).toMatchObject({ stage: "delivery" })

      const decided = await OrgRunner.decide(tmp.path, DELIVERY_ORG, run.runID, "approve")
      expect(decided.status).not.toBe("halted")
      expect(decided.stages["delivery"].status).toBe("completed")

      // One more advance lets the runner notice nothing is left running/awaiting/pending.
      const b = await OrgRunner.advance(deps, tmp.path, DELIVERY_ORG, run.runID, {})
      expect(b.done).toBe(true)

      const finalStatus = await OrgRunner.status(tmp.path, DELIVERY_ORG, run.runID)
      expect(finalStatus.run.status).toBe("completed")
    }
  })

  // --- 6. Graceful no-creds (security headline). ---
  describe("6. graceful no-creds (security headline): asc_submit and asc_status degrade cleanly with an EMPTY auth store + empty env", () => {
    test("resolveAscAuth itself returns undefined given a truly empty auth store and empty env (no mocking)", () => {
      expect(resolveAscAuth({ auth: undefined, env: {} })).toBeUndefined()
    })

    harness.instance("asc_submit: the clean 'configure your App Store Connect API key' message, metadata.unavailable:true, never throws, no PEM/secret in the output", () =>
      Effect.gen(function* () {
        // Simulates the tool-level effect of an empty auth store + empty env (resolveAscAuth
        // above already proves the pure resolver degrades the same way with no mocking at all).
        const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(undefined)
        try {
          const result = yield* runAscSubmit(noSpawner(), { bundle_id: "com.example.app", version: "1.2.0" })

          expect(result.output).toContain("App Store Connect delivery unavailable")
          expect(result.output).toContain("configure")
          expect(result.metadata.unavailable).toBe(true)
          expect(result.metadata.submitted).toBe(false)

          // SECURITY: never a PEM marker or key material in the output, even in this degraded path.
          expect(result.output).not.toContain("PRIVATE KEY")
          expect(result.output).not.toContain("BEGIN")
        } finally {
          cred.mockRestore()
        }
      }),
    )

    harness.instance("asc_status: the clean 'configure your App Store Connect API key' message, metadata.unavailable:true, never throws, no PEM/secret in the output", () =>
      Effect.gen(function* () {
        const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(undefined)
        try {
          const result = yield* runAscStatus({ version_id: "ver-1" })

          expect(result.output).toContain("App Store Connect delivery unavailable")
          expect(result.output).toContain("configure")
          expect(result.metadata.unavailable).toBe(true)

          expect(result.output).not.toContain("PRIVATE KEY")
          expect(result.output).not.toContain("BEGIN")
        } finally {
          cred.mockRestore()
        }
      }),
    )
  })

  // --- 7. (honest) metadata-posting gap. ---
  // TODO(W7-followup): operations.ts exports `updateVersionLocalization` (PATCHes
  // /v1/appStoreVersionLocalizations/<id> with an ASC {data:{type,id,attributes}} body - see
  // operations.test.ts's "updateVersionLocalization sends the ASC ... PATCH body" test) but
  // asc-submit.ts's `runSubmission` never calls it: there is no op yet to GET the per-locale
  // appStoreVersionLocalizations id for a version, so asc_submit has nothing to PATCH against.
  // The path that IS wired today is validate (asc_metadata_validate's `validateAscMetadata`, as
  // a pre-flight gate) -> ensure the app-store version -> create + submit the review submission.
  // The marketing listing text (name/subtitle/keywords/promo/description) is checked against
  // Apple's limits but never actually uploaded to App Store Connect. This test documents that
  // real, current gap rather than pretending the pipeline is further along than it is - it should
  // be replaced with an assertion that localizations WERE patched once the GET-localization-id op
  // and the PATCH wiring land in asc-submit.ts.
  harness.instance("asc_submit ensures the version and creates/submits the review, but never PATCHes appStoreVersionLocalizations, even with metadata supplied and validated", () =>
    Effect.gen(function* () {
      const { credential } = freshEcCredential("ISS-EXIT", "KID-EXIT")
      const cred = spyOn(AscAuth, "loadAscCredential").mockResolvedValue(credential)

      type Call = { url: string; method: string }
      const calls: Call[] = []
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const call: Call = { url: String(url), method: init?.method ?? "GET" }
        calls.push(call)
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
            JSON.stringify({
              data: { id: "ver-1", attributes: { versionString: "1.2.0", appStoreState: "PREPARE_FOR_SUBMISSION" } },
            }),
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
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(fetchImpl)

      try {
        const result = yield* runAscSubmit(noSpawner(), {
          bundle_id: "com.example.app",
          version: "1.2.0",
          metadata: [
            {
              locale: "en-US",
              name: "Keel",
              subtitle: "Cash flow copilot",
              promotionalText: "See your money, decide fast.",
              keywords: "budget,finance,ledger",
              description: "An on-device cash-flow copilot that never leaves your phone.",
            },
          ],
        })

        const summary = JSON.parse(result.output)
        expect(summary.submitted).toBe(true)
        expect(summary.metadataValidated).toBe(true) // the pre-flight limits GATE ran...
        // ...but the listing text was never actually posted: no PATCH to
        // appStoreVersionLocalizations anywhere in the call trace, despite `metadata` being given.
        expect(calls.some((c) => c.url.includes("appStoreVersionLocalizations"))).toBe(false)
        expect(calls.some((c) => c.method === "PATCH" && c.url.includes("Localizations"))).toBe(false)
      } finally {
        cred.mockRestore()
        fetchSpy.mockRestore()
      }
    }),
  )
})
