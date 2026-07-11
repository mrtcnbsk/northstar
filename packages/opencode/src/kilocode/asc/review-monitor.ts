// kilocode_change - new file
import { Clock, Duration, Effect, Option, Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { BackgroundJob } from "@/background/job"
import type { InstanceContext } from "@/project/instance-context"
import type { AscClient } from "./client"
import { getReviewState } from "./operations"

/**
 * Published whenever `reviewMonitorLoop` observes a monitored App Store Connect version's
 * `appStoreState` change while polling. `from`/`to` are the raw ASC state strings - see
 * `TERMINAL_REVIEW_STATES` for the values that end the poll.
 */
export const AscReviewState = BusEvent.define(
  "asc.review.state",
  Schema.Struct({
    versionId: Schema.String,
    from: Schema.String,
    to: Schema.String,
  }),
)

/**
 * `appStoreState` values ASC will not move out of on its own - review has run its course
 * (approved and waiting on the developer / live / rejected / pulled). Reaching one of these ends
 * `reviewMonitorLoop`. Not every ASC state is terminal (e.g. `IN_REVIEW`, `WAITING_FOR_REVIEW`,
 * `PREPARE_FOR_SUBMISSION` are all mid-flight) - this is a reasonable terminal subset covering the
 * outcomes a review submission can land in.
 */
export const TERMINAL_REVIEW_STATES: ReadonlySet<string> = new Set([
  "PENDING_DEVELOPER_RELEASE",
  "READY_FOR_SALE",
  "REJECTED",
  "DEVELOPER_REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
  "DEVELOPER_REMOVED_FROM_SALE",
])

/**
 * Returned when `reviewMonitorLoop` stops because `deadlineMs` elapsed before the state reached a
 * terminal value - never a real ASC `appStoreState`, so callers can tell a timeout apart from an
 * actual review outcome.
 */
export const REVIEW_MONITOR_TIMEOUT = "MONITOR_TIMEOUT"

const DEFAULT_POLL_MS = 60_000

export type ReviewStateChange = { versionId: string; from: string; to: string }

export type ReviewMonitorOptions = {
  client: AscClient
  versionId: string
  /** Poll interval in ms. Defaults to 60s. */
  pollMs?: number
  /** Cumulative time budget in ms before the loop gives up and resolves `REVIEW_MONITOR_TIMEOUT`. */
  deadlineMs: number
  /** Injected so tests can capture transitions without a real Bus/instance context. */
  publish: (change: ReviewStateChange) => Effect.Effect<void>
}

/**
 * Polls `getReviewState(client, versionId)` every `pollMs` until the ASC `appStoreState` reaches a
 * terminal value (`TERMINAL_REVIEW_STATES`) or `deadlineMs` elapses. Publishes a `from`/`to`
 * transition via the injected `publish` whenever the observed state differs from the previously
 * observed one - the very first read only sets the baseline, it never publishes (there's no `from`
 * yet). A `getReviewState` failure (typically `AscError` or a network error) is swallowed and
 * treated as "state unchanged": it never crashes the loop, polling just continues until the
 * deadline. Resolves with the final `appStoreState` string, or `REVIEW_MONITOR_TIMEOUT` if the
 * deadline elapsed first without a terminal state.
 */
export function reviewMonitorLoop(options: ReviewMonitorOptions): Effect.Effect<string> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS

  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    let lastState: string | undefined

    while (true) {
      const elapsed = (yield* Clock.currentTimeMillis) - startedAt
      if (elapsed > options.deadlineMs) return REVIEW_MONITOR_TIMEOUT

      const observed = yield* Effect.tryPromise({
        try: () => getReviewState(options.client, options.versionId),
        catch: (err) => err,
      }).pipe(Effect.option)
      // ^ a fetch error (AscError / network) is swallowed here on purpose - see the doc comment
      // above. `observed` stays `Option.none()`, which the branch below treats as "no new
      // reading"; the loop falls through to the sleep and tries again next poll.

      if (Option.isSome(observed)) {
        const current = observed.value
        if (lastState !== undefined && current !== lastState) {
          yield* options.publish({ versionId: options.versionId, from: lastState, to: current })
        }
        lastState = current
        if (TERMINAL_REVIEW_STATES.has(current)) return current
      }

      yield* Effect.sleep(Duration.millis(pollMs))
    }
  })
}

export type StartReviewMonitorOptions = {
  client: AscClient
  versionId: string
  pollMs?: number
  deadlineMs: number
}

/**
 * Runs `reviewMonitorLoop` as a `BackgroundJob`, wiring `publish` to `Bus.publish(busCtx,
 * AscReviewState, …)` so subscribers see `asc.review.state` events on the real bus. The job's
 * `output` (once it completes) is the final `appStoreState` string (or `REVIEW_MONITOR_TIMEOUT`).
 */
export function startReviewMonitor(
  jobService: BackgroundJob.Interface,
  busCtx: InstanceContext,
  options: StartReviewMonitorOptions,
): Effect.Effect<BackgroundJob.Info> {
  return jobService.start({
    type: "asc-review-monitor",
    title: `ASC review ${options.versionId}`,
    metadata: { versionId: options.versionId },
    run: reviewMonitorLoop({
      client: options.client,
      versionId: options.versionId,
      pollMs: options.pollMs,
      deadlineMs: options.deadlineMs,
      publish: (change) => Effect.promise(() => Bus.publish(busCtx, AscReviewState, change)),
    }),
  })
}
