// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { BackgroundJob } from "@/background/job"
import { requireInstance } from "../../fixture/fixture"
import { AscClient } from "../../../src/kilocode/asc/client"
import type { AscCredential } from "../../../src/kilocode/asc/auth"
import {
  AscReviewState,
  REVIEW_MONITOR_TIMEOUT,
  TERMINAL_REVIEW_STATES,
  reviewMonitorLoop,
  startReviewMonitor,
  type ReviewStateChange,
} from "../../../src/kilocode/asc/review-monitor"
import { testEffect } from "../../lib/effect"

const FIXED = 1_700_000_000_000

/**
 * A fake `AscClient` whose `fetch` returns `script[call]` (clamped to the last entry once the
 * script is exhausted, so a state "sticks" forever if the test wants a never-terminal sequence).
 * A `"ERROR"` entry makes that call's `fetch` throw, simulating a transient network/AscError
 * failure - see client.ts, `fetchImpl` is only ever expected to resolve to a `Response`, so a
 * thrown rejection surfaces to `getReviewState`'s caller as-is (no retry-with-real-timers path,
 * since `AscClient`'s retry logic only kicks in for retryable HTTP *statuses* on a resolved
 * `Response`, never for a rejected `fetch`).
 */
function scriptedClient(script: Array<string | "ERROR">) {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const credential: AscCredential = {
    issuerId: "ISS",
    keyId: "KID",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
  let call = 0
  const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
    const index = Math.min(call, script.length - 1)
    call++
    const entry = script[index]
    if (entry === "ERROR") throw new Error("network error")
    return new Response(JSON.stringify({ data: { id: "ver-1", attributes: { appStoreState: entry } } }), {
      status: 200,
    })
  }) as typeof fetch
  const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
  return { client, callCount: () => call }
}

/**
 * Drives a forked `reviewMonitorLoop` fiber to completion under `TestClock`: repeatedly advances
 * virtual time by `stepMs` and yields, letting the loop's `getReviewState` promise chain (fetch ->
 * response.text() -> JSON.parse, each a real microtask hop) settle and re-register its next
 * `Effect.sleep` between advances, instead of trying to jump the clock in one big leap (which can
 * race ahead of the fiber's async work and either skip a state or never converge). Stops as soon
 * as the fiber reports done via `pollUnsafe()`, then joins it. `maxSteps` is just a hang guard -
 * this all runs in virtual time, so it finishes near-instantly in wall-clock time regardless.
 */
const driveToCompletion = <A, E>(fiber: Fiber.Fiber<A, E>, stepMs = 50, maxSteps = 2000) =>
  Effect.gen(function* () {
    for (let i = 0; i < maxSteps; i++) {
      if (fiber.pollUnsafe() !== undefined) break
      yield* TestClock.adjust(stepMs)
      yield* Effect.yieldNow
    }
    return yield* Fiber.join(fiber)
  })

const it = testEffect(Layer.empty)

describe("asc/review-monitor: TERMINAL_REVIEW_STATES", () => {
  test("covers the reasonable ASC appStoreState terminal set", () => {
    expect([...TERMINAL_REVIEW_STATES].sort()).toEqual(
      [
        "PENDING_DEVELOPER_RELEASE",
        "READY_FOR_SALE",
        "REJECTED",
        "DEVELOPER_REJECTED",
        "METADATA_REJECTED",
        "INVALID_BINARY",
        "DEVELOPER_REMOVED_FROM_SALE",
      ].sort(),
    )
  })

  test("does not treat mid-flight states as terminal", () => {
    for (const state of ["WAITING_FOR_REVIEW", "IN_REVIEW", "PREPARE_FOR_SUBMISSION", "PROCESSING_FOR_APP_STORE"]) {
      expect(TERMINAL_REVIEW_STATES.has(state)).toBe(false)
    }
  })
})

describe("asc/review-monitor: reviewMonitorLoop", () => {
  it.effect("WAITING_FOR_REVIEW -> IN_REVIEW -> REJECTED: 2 publishes, resolves REJECTED", () =>
    Effect.gen(function* () {
      const { client, callCount } = scriptedClient(["WAITING_FOR_REVIEW", "IN_REVIEW", "REJECTED"])
      const captured: ReviewStateChange[] = []
      const fiber = yield* reviewMonitorLoop({
        client,
        versionId: "ver-1",
        pollMs: 1000,
        deadlineMs: 600_000,
        publish: (change) => Effect.sync(() => captured.push(change)),
      }).pipe(Effect.forkChild)

      const result = yield* driveToCompletion(fiber)

      expect(result).toBe("REJECTED")
      expect(captured).toEqual([
        { versionId: "ver-1", from: "WAITING_FOR_REVIEW", to: "IN_REVIEW" },
        { versionId: "ver-1", from: "IN_REVIEW", to: "REJECTED" },
      ])
      expect(callCount()).toBe(3)
    }),
  )

  it.effect("WAITING_FOR_REVIEW -> IN_REVIEW -> READY_FOR_SALE: 2 publishes, resolves READY_FOR_SALE", () =>
    Effect.gen(function* () {
      const { client, callCount } = scriptedClient(["WAITING_FOR_REVIEW", "IN_REVIEW", "READY_FOR_SALE"])
      const captured: ReviewStateChange[] = []
      const fiber = yield* reviewMonitorLoop({
        client,
        versionId: "ver-2",
        pollMs: 1000,
        deadlineMs: 600_000,
        publish: (change) => Effect.sync(() => captured.push(change)),
      }).pipe(Effect.forkChild)

      const result = yield* driveToCompletion(fiber)

      expect(result).toBe("READY_FOR_SALE")
      expect(captured).toEqual([
        { versionId: "ver-2", from: "WAITING_FOR_REVIEW", to: "IN_REVIEW" },
        { versionId: "ver-2", from: "IN_REVIEW", to: "READY_FOR_SALE" },
      ])
      expect(callCount()).toBe(3)
    }),
  )

  it.effect("a fetch that throws for a few polls then recovers: no crash, still resolves", () =>
    Effect.gen(function* () {
      const { client, callCount } = scriptedClient(["ERROR", "ERROR", "WAITING_FOR_REVIEW", "READY_FOR_SALE"])
      const captured: ReviewStateChange[] = []
      const fiber = yield* reviewMonitorLoop({
        client,
        versionId: "ver-3",
        pollMs: 1000,
        deadlineMs: 600_000,
        publish: (change) => Effect.sync(() => captured.push(change)),
      }).pipe(Effect.forkChild)

      const result = yield* driveToCompletion(fiber)

      expect(result).toBe("READY_FOR_SALE")
      // The two ERRORs are treated as "unchanged" (no baseline yet) - only the WAITING_FOR_REVIEW
      // -> READY_FOR_SALE transition publishes.
      expect(captured).toEqual([{ versionId: "ver-3", from: "WAITING_FOR_REVIEW", to: "READY_FOR_SALE" }])
      expect(callCount()).toBe(4)
    }),
  )

  it.effect("errors on every poll: never crashes, still resolves at the deadline", () =>
    Effect.gen(function* () {
      const { client } = scriptedClient(["ERROR"])
      const captured: ReviewStateChange[] = []
      const fiber = yield* reviewMonitorLoop({
        client,
        versionId: "ver-4",
        pollMs: 500,
        deadlineMs: 2000,
        publish: (change) => Effect.sync(() => captured.push(change)),
      }).pipe(Effect.forkChild)

      const result = yield* driveToCompletion(fiber)

      expect(result).toBe(REVIEW_MONITOR_TIMEOUT)
      expect(captured).toEqual([])
    }),
  )

  it.effect("deadline exceeded while never reaching a terminal state: resolves to a timeout state without hanging", () =>
    Effect.gen(function* () {
      // Single-entry script clamps to the same non-terminal state on every call.
      const { client } = scriptedClient(["WAITING_FOR_REVIEW"])
      const captured: ReviewStateChange[] = []
      const fiber = yield* reviewMonitorLoop({
        client,
        versionId: "ver-5",
        pollMs: 1000,
        deadlineMs: 2500,
        publish: (change) => Effect.sync(() => captured.push(change)),
      }).pipe(Effect.forkChild)

      const result = yield* driveToCompletion(fiber)

      expect(result).toBe(REVIEW_MONITOR_TIMEOUT)
      // Never changed state, so never published.
      expect(captured).toEqual([])
    }),
  )

  it.effect("the very first observed state never publishes (no `from` yet)", () =>
    Effect.gen(function* () {
      const { client } = scriptedClient(["READY_FOR_SALE"])
      const captured: ReviewStateChange[] = []
      const fiber = yield* reviewMonitorLoop({
        client,
        versionId: "ver-6",
        pollMs: 1000,
        deadlineMs: 600_000,
        publish: (change) => Effect.sync(() => captured.push(change)),
      }).pipe(Effect.forkChild)

      const result = yield* driveToCompletion(fiber)

      expect(result).toBe("READY_FOR_SALE")
      expect(captured).toEqual([])
    }),
  )
})

describe("asc/review-monitor: startReviewMonitor (BackgroundJob wiring)", () => {
  const jobIt = testEffect(BackgroundJob.defaultLayer)

  // kilocode_change - light assertion per plan: startReviewMonitor calls BackgroundJob.start with
  // the right type/metadata/title. Runs on the REAL clock (it.instance, not it.effect) so the
  // script resolves terminal on the FIRST poll - no sleep is ever reached, so no real-time wait.
  jobIt.instance(
    "starts a BackgroundJob typed asc-review-monitor with versionId metadata, output is the terminal state",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const ctx = yield* requireInstance
        const { client } = scriptedClient(["READY_FOR_SALE"])

        const job = yield* startReviewMonitor(jobs, ctx, { client, versionId: "ver-7", deadlineMs: 10_000 })

        expect(job.type).toBe("asc-review-monitor")
        expect(job.title).toBe("ASC review ver-7")
        expect(job.metadata).toEqual({ versionId: "ver-7" })

        const waited = yield* jobs.wait({ id: job.id })
        expect(waited.timedOut).toBe(false)
        expect(waited.info?.status).toBe("completed")
        expect(waited.info?.output).toBe("READY_FOR_SALE")
      }),
  )
})

describe("asc/review-monitor: AscReviewState bus event", () => {
  test("is registered under the asc.review.state type", () => {
    expect(AscReviewState.type).toBe("asc.review.state")
  })
})
