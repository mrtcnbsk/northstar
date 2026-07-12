// kilocode_change - new file
import { OrgSchema } from "./schema"
import { OrgState } from "./state"

/**
 * Per-agent metrics rollup + threshold-driven health scoring (W8.2). `aggregate` and `health` are
 * PURE functions of their inputs - no clock reads, no I/O - mirroring the deterministic style of
 * `postmortem.ts`'s `build`. `collect` is the thin async boundary that reads every run's
 * state.json plus organization.jsonc off disk and feeds them through `aggregate`.
 *
 * Granularity is CHIEF-LEVEL: `state.json` records no agent name, only a `taskID` (session id)
 * per stage. A stage is attributed to an agent by joining `stage name -> org.departments[stage].chief`;
 * a worker's cost is folded into its chief's session and is not broken out separately.
 */
export namespace OrgMetrics {
  export type AgentMetrics = {
    agent: string
    /** Distinct runs that had at least one stage attributed to this agent. */
    runs: number
    /** Total stages (across all runs) attributed to this agent. */
    stages: number
    /** Sum of `OrgState.stageCost` over every attributed stage (unknown-cost stages contribute $0). */
    totalCost: number
    /** `totalCost` divided by the count of stages with a KNOWN cost (see costKnown below) - not
     * `stages`, so a stage whose cost was never captured (still running, or costOf failed) can't
     * silently drag the average toward a false $0. 0 when no stage has a known cost. */
    avgCostPerStage: number
    completed: number
    failed: number
    /** Stages currently `awaiting_approval` (a human gate blocker, not a terminal outcome). */
    blocked: number
    /** `completed / (completed + failed)`. Defaults to 1 when there are no terminal stages yet -
     * an agent with no failures on record should read as healthy, not as 0/0 = "unhealthy". */
    successRate: number
    /** Average `Date.parse(completedAt) - Date.parse(startedAt)` over stages with both timestamps.
     * `null` when no attributed stage has both. NOTE: for a stage that went through `decide()`'s
     * "revise" path, `startedAt`/`completedAt` reflect only the LAST iteration (revise resets
     * `startedAt` and clears `completedAt` on the stage in place) - this is per-iteration latency,
     * not the stage's total wall-clock time across every revise round. */
    avgLatencyMs: number | null
  }

  export type HealthThresholds = {
    /** `failed / stages` strictly ABOVE this ceiling is penalized. Exactly-at-ceiling is fine. */
    errorRateCeiling: number
    /** `avgLatencyMs` strictly ABOVE this ceiling (in ms) is penalized. `null` is never penalized -
     * an agent with no latency data yet is not assumed to be slow. */
    latencyCeilingMs: number
  }

  /** Owner-approved defaults, same shape/spirit as schema.ts's BUDGET_DEFAULTS. */
  const DEFAULTS: HealthThresholds = {
    errorRateCeiling: 0.2, // >20% of stages failing is a red flag
    latencyCeilingMs: 30 * 60 * 1000, // >30 minutes average stage latency is a red flag
  }

  export type Health = {
    /** 0-100, floored at 0. Starts at 100 and loses points per violated threshold. */
    score: number
    band: "healthy" | "degraded" | "unhealthy"
    /** Human-readable reason per violated threshold; [] when fully healthy. */
    reasons: string[]
  }

  // Sized so that BOTH thresholds being violated at once floors the score at 0 (60 + 51 = 111,
  // clamped below), while a single violation still lands squarely in "unhealthy" (<50) on its own.
  // LATENCY_PENALTY is 51, not 50: the band boundary (score >= 50 ? "degraded" : "unhealthy") is
  // INCLUSIVE of 50, so a latency-only violation at exactly 100-50=50 would land "degraded" —
  // contradicting this doc-comment's claim that a single violation is always "unhealthy".
  const ERROR_RATE_PENALTY = 60
  const LATENCY_PENALTY = 51

  type Bucket = {
    agent: string
    runIDs: Set<string>
    stages: number
    totalCost: number
    /** Count of stages with a KNOWN cost (a non-empty `costs` map, or a defined legacy `cost`
     * field) - the denominator for avgCostPerStage. A stage with neither is "unknown", not "free". */
    knownCostStages: number
    completed: number
    failed: number
    blocked: number
    latencySumMs: number
    latencyCount: number
  }

  function bucketFor(buckets: Map<string, Bucket>, agent: string): Bucket {
    const existing = buckets.get(agent)
    if (existing) return existing
    const created: Bucket = {
      agent,
      runIDs: new Set(),
      stages: 0,
      totalCost: 0,
      knownCostStages: 0,
      completed: 0,
      failed: 0,
      blocked: 0,
      latencySumMs: 0,
      latencyCount: 0,
    }
    buckets.set(agent, created)
    return created
  }

  /** A stage's cost is "known" when either the modern `costs` map has at least one entry, or the
   * deprecated single-slot `cost` field is explicitly set - as opposed to neither being present,
   * which means cost was simply never captured (stage still running, costOf lookup failed, etc). */
  function hasKnownCost(stage: OrgState.Stage): boolean {
    return (stage.costs !== undefined && Object.keys(stage.costs).length > 0) || stage.cost !== undefined
  }

  /**
   * Rolls up every run's stages into one `AgentMetrics` per chief. Iterates `org.departments` to
   * resolve `stage -> chief`; a stage whose name has no matching department (historical org drift -
   * organization.jsonc changed since the run was created) is silently skipped, never thrown on.
   * Pure - no I/O, no clock reads; safe to call from tests or an HTTP handler alike.
   */
  export function aggregate(org: OrgSchema.Organization, runs: OrgState.Run[]): AgentMetrics[] {
    const buckets = new Map<string, Bucket>()

    for (const run of runs) {
      for (const [stageName, stage] of Object.entries(run.stages)) {
        const dept = org.departments[stageName]
        if (!dept) continue // org drift: this stage no longer (or not yet) maps to a department

        const bucket = bucketFor(buckets, dept.chief)
        bucket.runIDs.add(run.runID)
        bucket.stages += 1

        const cost = OrgState.stageCost(stage)
        bucket.totalCost += cost
        if (hasKnownCost(stage)) bucket.knownCostStages += 1

        if (stage.status === "completed") bucket.completed += 1
        else if (stage.status === "failed") bucket.failed += 1
        else if (stage.status === "awaiting_approval") bucket.blocked += 1

        if (stage.startedAt && stage.completedAt) {
          const latency = Date.parse(stage.completedAt) - Date.parse(stage.startedAt)
          if (!Number.isNaN(latency)) {
            bucket.latencySumMs += latency
            bucket.latencyCount += 1
          }
        }
      }
    }

    return Array.from(buckets.values()).map((bucket) => {
      const terminal = bucket.completed + bucket.failed
      return {
        agent: bucket.agent,
        runs: bucket.runIDs.size,
        stages: bucket.stages,
        totalCost: bucket.totalCost,
        avgCostPerStage: bucket.knownCostStages > 0 ? bucket.totalCost / bucket.knownCostStages : 0,
        completed: bucket.completed,
        failed: bucket.failed,
        blocked: bucket.blocked,
        successRate: terminal > 0 ? bucket.completed / terminal : 1,
        avgLatencyMs: bucket.latencyCount > 0 ? bucket.latencySumMs / bucket.latencyCount : null,
      }
    })
  }

  /**
   * Pure, threshold-driven health score for one agent's metrics. Starts at 100; each violated
   * threshold subtracts a fixed penalty and appends a human-readable reason. Boundaries are
   * exclusive (a metric exactly AT its ceiling is not penalized - only strictly above it is), and
   * `avgLatencyMs === null` is never penalized (no data is not evidence of bad latency).
   */
  export function health(m: AgentMetrics, thresholds: HealthThresholds = DEFAULTS): Health {
    const reasons: string[] = []
    let score = 100

    const errorRate = m.stages > 0 ? m.failed / m.stages : 0
    if (errorRate > thresholds.errorRateCeiling) {
      score -= ERROR_RATE_PENALTY
      reasons.push(
        `error rate ${(errorRate * 100).toFixed(1)}% exceeds ceiling ${(thresholds.errorRateCeiling * 100).toFixed(1)}%`,
      )
    }

    if (m.avgLatencyMs !== null && m.avgLatencyMs > thresholds.latencyCeilingMs) {
      score -= LATENCY_PENALTY
      reasons.push(`avg latency ${m.avgLatencyMs}ms exceeds ceiling ${thresholds.latencyCeilingMs}ms`)
    }

    score = Math.max(0, score)
    const band = score >= 80 ? "healthy" : score >= 50 ? "degraded" : "unhealthy"
    return { score, band, reasons }
  }

  /**
   * Cross-run collector: lists every run under `.kilo/org/runs`, reads each one, and aggregates
   * the readable ones. Mirrors `OrgRunsView.list`'s per-run try/catch skip-on-corrupt: a single
   * unreadable/schema-invalid state.json is logged and skipped rather than failing the whole
   * collection. A missing/invalid `organization.jsonc` degrades to an empty org (no departments,
   * so `aggregate` returns []) rather than throwing - metrics are best-effort observability, not a
   * load-bearing path.
   */
  export async function collect(projectDir: string): Promise<AgentMetrics[]> {
    const ids = await OrgState.list(projectDir)
    const runs: OrgState.Run[] = []
    for (const id of ids) {
      try {
        runs.push(await OrgState.read(projectDir, id))
      } catch (e) {
        console.warn(`[metrics] skipping run "${id}": ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const org = await OrgSchema.loadOrganization(projectDir).catch((e: unknown) => {
      console.warn(
        `[metrics] no usable organization.jsonc for ${projectDir}, degrading to an empty org: ${e instanceof Error ? e.message : String(e)}`,
      )
      return { ceo: "", departments: {}, shared: [], pipeline: [], toolpacks: [] } as OrgSchema.Organization
    })

    return aggregate(org, runs)
  }
}
