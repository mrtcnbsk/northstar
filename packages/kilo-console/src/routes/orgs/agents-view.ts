import type { AgentMetricsResponse, AgentMetricsRow } from "@kilocode/sdk/v2/client"

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link"

export type HealthBand = AgentMetricsRow["health"]["band"]

export type AgentRow = {
  agent: string
  runs: number
  stages: number
  totalCost: number
  avgCostPerStage: number
  completed: number
  failed: number
  blocked: number
  successRate: number
  avgLatencyMs: number | null
  healthScore: number
  healthBand: HealthBand
  badgeVariant: BadgeVariant
}

const healthBadgeVariants: Record<HealthBand, BadgeVariant> = {
  healthy: "default",
  degraded: "secondary",
  unhealthy: "destructive",
}

// Ranks worst health first so a scoreboard reader's eye lands on agents that need attention.
const healthBandRank: Record<HealthBand, number> = {
  unhealthy: 0,
  degraded: 1,
  healthy: 2,
}

function number(input: number | "NaN" | "Infinity" | "-Infinity") {
  if (typeof input === "number" && Number.isFinite(input)) return input
  return 0
}

// `avgLatencyMs` is `Schema.NullOr(Schema.Number)` server-side and genuinely means "no data" when
// null (see packages/opencode/src/kilocode/organization/metrics.ts) -- distinct from a real 0ms
// average. Non-finite wire values collapse to the same "no data" state rather than 0.
function latency(input: AgentMetricsRow["avgLatencyMs"] | null | undefined): number | null {
  if (input === null || input === undefined) return null
  if (typeof input === "number" && Number.isFinite(input)) return input
  return null
}

export function formatCost(input: number): string {
  const value = Number.isFinite(input) ? input : 0
  return `$${value.toFixed(2)}`
}

export function formatPercent(input: number): string {
  const value = Number.isFinite(input) ? input : 0
  return `${Math.round(value * 100)}%`
}

export function formatLatency(input: number | null): string {
  if (input === null || !Number.isFinite(input)) return "—"
  if (input < 1000) return `${Math.round(input)}ms`
  return `${(input / 1000).toFixed(1)}s`
}

export function healthBadge(band: HealthBand): BadgeVariant {
  return healthBadgeVariants[band] ?? "outline"
}

export function agentRows(res: AgentMetricsResponse | undefined): AgentRow[] {
  if (!res) return []
  return res.agents
    .map((item) => ({
      agent: item.agent,
      runs: number(item.runs),
      stages: number(item.stages),
      totalCost: number(item.totalCost),
      avgCostPerStage: number(item.avgCostPerStage),
      completed: number(item.completed),
      failed: number(item.failed),
      blocked: number(item.blocked),
      successRate: number(item.successRate),
      avgLatencyMs: latency(item.avgLatencyMs),
      healthScore: number(item.health.score),
      healthBand: item.health.band,
      badgeVariant: healthBadge(item.health.band),
    }))
    .toSorted(
      (a, b) => healthBandRank[a.healthBand] - healthBandRank[b.healthBand] || b.totalCost - a.totalCost,
    )
}
