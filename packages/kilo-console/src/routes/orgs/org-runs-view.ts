import type { OrgAuditEntry, OrgRunDetailResponse, OrgRunStageView } from "@kilocode/sdk/v2/client"

export type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link"

export type StageStatus = OrgRunStageView["status"]

export type StageTimelineItem = {
  stage: string
  status: StageStatus
  cost: number
  startedAt: string
  completedAt: string
  decision: OrgRunStageView["decision"] | undefined
  badgeVariant: BadgeVariant
}

const stageBadgeVariants: Record<StageStatus, BadgeVariant> = {
  pending: "outline",
  running: "secondary",
  awaiting_approval: "default",
  completed: "secondary",
  failed: "destructive",
}

function number(input: number | "NaN" | "Infinity" | "-Infinity") {
  if (typeof input === "number" && Number.isFinite(input)) return input
  return 0
}

export function formatCost(input: number): string {
  const value = Number.isFinite(input) ? input : 0
  return `$${value.toFixed(2)}`
}

export function runStatusBadge(status: string): BadgeVariant {
  if (status === "active") return "secondary"
  if (status === "halted") return "destructive"
  if (status === "completed") return "default"
  return "outline"
}

export function stageBadge(status: StageStatus): BadgeVariant {
  return stageBadgeVariants[status] ?? "outline"
}

export function stageTimeline(detail: OrgRunDetailResponse | undefined): StageTimelineItem[] {
  if (!detail) return []
  return detail.stages.map((item) => ({
    stage: item.stage,
    status: item.status,
    cost: number(item.cost),
    startedAt: item.startedAt,
    completedAt: item.completedAt,
    decision: item.decision,
    badgeVariant: stageBadge(item.status),
  }))
}

export function awaitingGateStages(detail: OrgRunDetailResponse | undefined): string[] {
  if (!detail) return []
  return detail.stages.filter((item) => item.status === "awaiting_approval").map((item) => item.stage)
}

export function auditTrail(detail: OrgRunDetailResponse | undefined): OrgAuditEntry[] {
  return detail?.audit ?? []
}

export type CostRow = { stage: string; cost: number }

export function costRows(detail: OrgRunDetailResponse | undefined): CostRow[] {
  if (!detail) return []
  return detail.stages.map((item) => ({ stage: item.stage, cost: number(item.cost) }))
}

export function costTotal(detail: OrgRunDetailResponse | undefined): number {
  if (!detail) return 0
  return number(detail.totalCost)
}

export type AwaitingSinceItem = { stage: string; sinceMs: number }

export function awaitingSince(detail: OrgRunDetailResponse | undefined, now: number): AwaitingSinceItem[] {
  if (!detail) return []
  return detail.stages
    .filter((item) => item.status === "awaiting_approval")
    .map((item) => {
      const started = item.startedAt ? new Date(item.startedAt).getTime() : Number.NaN
      const sinceMs = Number.isFinite(started) ? Math.max(0, now - started) : 0
      return { stage: item.stage, sinceMs }
    })
}
