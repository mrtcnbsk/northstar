// kilocode_change - new file
import { OrgMetrics } from "./metrics"

/**
 * Pure capability matcher + health-aware ranker (W9.1). Mirrors metrics.ts's pure-core style -
 * no I/O, no clock reads, no Effect - so it's testable with fabricated inputs exactly like
 * `OrgMetrics.aggregate`/`health`. The thin `org_route` tool (W9.2) is the only caller that
 * touches disk: it assembles `TaskNeed`/`Candidate[]`/health map from real org state and hands
 * them to `rank` here.
 */
export namespace OrgRouting {
  export type TaskNeed = {
    capabilities?: string[]
    type?: string
  }

  export type Candidate = {
    agent: string
    capabilities?: string[]
    preferredTypes?: string[]
  }

  export type RouteWeights = {
    match: number
    health: number
  }

  export type Ranked = {
    agent: string
    matchScore: number
    /** `undefined` when the candidate has no entry in `healthByAgent` (never run yet) - see
     * `rank`'s neutral-prior handling below for how that absence is scored. */
    health?: OrgMetrics.Health
    score: number
    reasons: string[]
  }

  export const DEFAULT_WEIGHTS: RouteWeights = { match: 0.7, health: 0.3 }

  /** A `need.type` match against `candidate.preferredTypes` adds this much to the coverage score,
   * before the final clamp to [0,1]. Bounded (not e.g. +1) so a bare type match can't make a
   * capability-mismatched candidate look as good as a real capability match - it can only nudge
   * an already-partial match higher, or top off a full match (still clamped to 1). */
  const TYPE_MATCH_BONUS = 0.15

  /** Score an agent with NO entry in `healthByAgent` as if its health were this - a neutral
   * "healthy until proven otherwise" prior, mirroring `OrgMetrics.aggregate` defaulting
   * `successRate` to 1 for an agent with zero terminal stages. A brand-new, well-matched agent
   * must not be buried under agents with a merely-OK track record just because it hasn't run
   * yet. */
  const NEUTRAL_HEALTH_SCORE = 100

  /**
   * need-coverage overlap: |need.capabilities ∩ candidate.capabilities| / |need.capabilities|.
   *
   * Chosen over Jaccard (|∩| / |∪|) deliberately: Jaccard penalizes a candidate for having MORE
   * capabilities than the task needs, which is backwards for routing - a generalist agent with a
   * broad capability list shouldn't score worse than a narrow specialist just because its
   * capability set is bigger. Need-coverage only asks "does this candidate cover what the task
   * needs", which is the question routing actually cares about.
   *
   * Either side undefined or empty -> 0 (never NaN): an empty `need.capabilities` has nothing to
   * measure coverage of, and an empty/absent `candidate.capabilities` can't cover anything.
   */
  function coverage(need: TaskNeed, candidate: Candidate): number {
    const needCaps = need.capabilities
    const candCaps = candidate.capabilities
    if (!needCaps || needCaps.length === 0) return 0
    if (!candCaps || candCaps.length === 0) return 0
    const candSet = new Set(candCaps)
    const matched = needCaps.filter((c) => candSet.has(c)).length
    return matched / needCaps.length
  }

  /**
   * Pure 0..1 match score between what a task needs and what a candidate offers: need-coverage
   * of capabilities (see `coverage` above), plus a bounded bonus when `need.type` is one of the
   * candidate's `preferredTypes`. Always clamped to [0,1]; always a number, never NaN.
   */
  export function capabilityScore(need: TaskNeed, candidate: Candidate): number {
    let score = coverage(need, candidate)
    if (need.type && candidate.preferredTypes?.includes(need.type)) {
      score += TYPE_MATCH_BONUS
    }
    return Math.min(1, Math.max(0, score))
  }

  function describeCapabilityMatch(need: TaskNeed, candidate: Candidate): string {
    const needCaps = need.capabilities ?? []
    if (needCaps.length === 0) return "no capability requirements"
    const candSet = new Set(candidate.capabilities ?? [])
    const matched = needCaps.filter((c) => candSet.has(c)).length
    return `matched ${matched}/${needCaps.length} capabilities`
  }

  function describeHealth(health: OrgMetrics.Health | undefined): string {
    if (!health) return "health: unrated, neutral prior assumed"
    return `health: ${health.band} (score ${health.score})`
  }

  function reasonsFor(
    need: TaskNeed,
    candidate: Candidate,
    health: OrgMetrics.Health | undefined,
  ): string[] {
    const reasons = [describeCapabilityMatch(need, candidate)]
    if (need.type && candidate.preferredTypes?.includes(need.type)) {
      reasons.push(`preferred type "${need.type}" match`)
    }
    reasons.push(describeHealth(health))
    return reasons
  }

  /**
   * Ranks candidates best-first for a task's needs: `score = weights.match * matchScore +
   * weights.health * (health / 100)`, where `health` defaults to `NEUTRAL_HEALTH_SCORE` (not 0)
   * for any candidate absent from `healthByAgent`. Ties break by agent name ascending, so the
   * total order is deterministic regardless of input/Map iteration order. Pure - no I/O, no
   * clock reads.
   */
  export function rank(
    need: TaskNeed,
    candidates: Candidate[],
    healthByAgent: Map<string, OrgMetrics.Health>,
    weights: RouteWeights = DEFAULT_WEIGHTS,
  ): Ranked[] {
    const ranked = candidates.map((candidate) => {
      const matchScore = capabilityScore(need, candidate)
      const health = healthByAgent.get(candidate.agent)
      const healthScore = health?.score ?? NEUTRAL_HEALTH_SCORE
      const score = weights.match * matchScore + weights.health * (healthScore / 100)
      return {
        agent: candidate.agent,
        matchScore,
        health,
        score,
        reasons: reasonsFor(need, candidate, health),
      }
    })

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0
    })

    return ranked
  }
}
