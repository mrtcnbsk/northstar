// kilocode_change - new file
import { OrgSchema } from "@/kilocode/organization/schema" // kilocode_change - Task 8.3: value import (dryRunReport calls OrgSchema.validate/crossCheck)
import type { OrgAuditEntry, OrgRunBudget, OrgRunDetailResponse, OrgRunStageView, OrgRunSummary } from "@kilocode/sdk/v2/client"

/**
 * Pure, org-free-of-side-effects view builders for the TUI Cockpit dashboard (Task 8.1a, EPIC 8).
 * Kept independent of any HTTP/SDK client wiring (that's 8.1b) so they can be unit-tested directly
 * with in-memory fixtures. Mirrors the read-only-view-builder pattern used by
 * `packages/kilo-console/src/routes/orgs/org-runs-view.ts` and `OrgRunsView` (server/httpapi/handlers/org-runs.ts).
 *
 * `stageTimeline`/`formatCost`/`stageBadge`/`auditTrail`/`badgeToThemeKey` below are ported from
 * `org-runs-view.ts` (Task 8.1b) — that module lives in `packages/kilo-console`, which the TUI
 * package (`packages/opencode`) doesn't depend on, so the small pure pieces the Cockpit dashboard
 * needs are copied here rather than imported cross-package. `BadgeVariant` is the web (shadcn Badge)
 * token vocabulary; `badgeToThemeKey` maps it to a TUI theme color key (see `view.tsx`).
 */

/** Minimal structural shape of a per-stage status view -- satisfied by the SDK's `OrgRunStageView`
 * (and therefore by a real `OrgRunDetailResponse.stages`) without coupling this module to the SDK
 * package or to every other field on the detail response. */
export type StageStatusView = {
  stage: string
  status: string
}

export type AgentTreeDepartment = {
  stage: string
  chief: string
  status: string
  workers: string[]
}

export type AgentTree = {
  ceo: string
  departments: AgentTreeDepartment[]
}

/**
 * Builds the Tier-A agent tree: ceo + one row per pipeline stage (chief, worker roster, and the
 * chief's "liveness" -- the stage's current status from the run detail). Pipeline order is
 * preserved (org.pipeline is already ordered; see OrgSchema.Organization). A pipeline stage
 * without a matching detail.stages entry (shouldn't happen -- OrgState.create seeds every pipeline
 * stage up front) falls back to "pending" rather than throwing, keeping this a total function.
 *
 * kilocode_change - wave-close review fix: a pipeline stage without a matching `departments` entry
 * CAN happen (a hand-edited `.kilo/organization.jsonc` -- `OrgSchema.parse` is structural-only and
 * does not run the `validate()` cross-check that flags a stage/department mismatch, see
 * `schema.ts`'s validate()). Dereferencing `dept.chief`/`dept.workers` on `undefined` would throw
 * out of the `tree()` memo in view.tsx to the app ErrorBoundary and crash the whole TUI, so this
 * emits a safe placeholder row instead, keeping the function TOTAL over any structurally-valid org.
 */
export function buildAgentTree(org: OrgSchema.Organization, detail: { stages: StageStatusView[] }): AgentTree {
  const statusByStage = new Map(detail.stages.map((s) => [s.stage, s.status]))
  return {
    ceo: org.ceo,
    departments: org.pipeline.map(({ stage }) => {
      const dept = org.departments[stage]
      const status = statusByStage.get(stage) ?? "pending"
      if (!dept) return { stage, chief: "(no department)", status, workers: [] }
      return {
        stage,
        chief: dept.chief,
        status,
        workers: dept.workers,
      }
    }),
  }
}

export type BudgetGaugeInput = {
  run: number
  escalationThreshold: number
  spent: number
  escalated?: boolean
}

export type BudgetGauge = {
  spentFraction: number
  thresholdFraction: number
  overThreshold: boolean
  overCeiling: boolean
  escalated: boolean
}

/**
 * Reduces a run's budget block (see OrgRunBudget on the org-runs HTTP response) to the fractions
 * and booleans the Cockpit's budget gauge renders. `run <= 0` (no budget configured / degraded)
 * short-circuits to an all-zero/false gauge so a division by zero can never surface as NaN.
 */
export function budgetGauge(budget: BudgetGaugeInput): BudgetGauge {
  const { run, escalationThreshold, spent, escalated } = budget
  if (run <= 0) {
    return { spentFraction: 0, thresholdFraction: 0, overThreshold: false, overCeiling: false, escalated: !!escalated }
  }
  return {
    spentFraction: Math.min(1, spent / run),
    thresholdFraction: escalationThreshold / run,
    overThreshold: spent >= escalationThreshold,
    overCeiling: spent >= run,
    escalated: !!escalated,
  }
}

/** The SDK guards NaN/Infinity over the wire by widening numeric fields to include the string
 * sentinels "NaN"/"Infinity"/"-Infinity". Coerces back to a plain finite number (default 0) so
 * downstream pure view helpers (`stageTimeline`, `budgetFromRun`) never have to think about it. */
function number(input: number | "NaN" | "Infinity" | "-Infinity"): number {
  return typeof input === "number" && Number.isFinite(input) ? input : 0
}

export function formatCost(input: number): string {
  const value = Number.isFinite(input) ? input : 0
  return `$${value.toFixed(2)}`
}

/** Web (shadcn `Badge`) variant vocabulary, ported from `org-runs-view.ts` — kept as-is so
 * `stageBadge` stays a straight port; `badgeToThemeKey` (below) maps it to TUI theme colors. */
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
  skipped: "ghost",
  failed: "destructive",
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

export function auditTrail(detail: OrgRunDetailResponse | undefined): OrgAuditEntry[] {
  return detail?.audit ?? []
}

/** Coerces the SDK's `OrgRunBudget` (numeric fields may arrive as NaN/Infinity sentinels — see
 * `number()` above) into `budgetGauge`'s plain-number `BudgetGaugeInput`. */
export function budgetFromRun(budget: OrgRunBudget): BudgetGaugeInput {
  return {
    run: number(budget.run),
    escalationThreshold: number(budget.escalationThreshold),
    spent: number(budget.spent),
    escalated: budget.escalated,
  }
}

/** Maps a web `BadgeVariant` to a TUI theme color key (`view.tsx` indexes `useTheme().theme` with
 * the result). Returns the key name rather than a resolved color so this module stays free of any
 * `@tui/*` import (path-aliased, TUI-only) — keeps it independently unit-testable like the rest of
 * this file. */
export function badgeToThemeKey(variant: BadgeVariant): "text" | "textMuted" | "warning" | "error" | "success" {
  switch (variant) {
    case "destructive":
      return "error"
    case "default":
      return "warning"
    case "secondary":
      return "success"
    case "outline":
    case "ghost":
    case "link":
    default:
      return "textMuted"
  }
}

// kilocode_change start - Task 8.3 (EPIC 8): run-list home + --dry-run preflight

/** Ported straight from `org-runs-view.ts`'s `runStatusBadge` (badges the org-RUN, not a per-stage
 * status — see `stageBadge` above for that). Same cross-package-copy rationale as the rest of this
 * file's ports (see the module doc comment). */
export function runStatusBadge(status: string): BadgeVariant {
  if (status === "active") return "secondary"
  if (status === "halted") return "destructive"
  if (status === "completed") return "default"
  return "outline"
}

export type RunListRow = {
  runID: string
  idea: string
  status: string
  totalCost: number
  currentStage: string | null
  awaitingGate: boolean
  badge: BadgeVariant
}

/**
 * Maps `orgRuns.list` summaries (already newest-first over the wire, see OrgRunsView.list) to the
 * Cockpit run-list home's row view-model (Task 8.3, `view.tsx` renders this when `route.data.runID`
 * is absent). A straight `.map` preserves that newest-first order — nothing here re-sorts.
 */
export function buildRunList(summaries: readonly OrgRunSummary[]): RunListRow[] {
  return summaries.map((s) => ({
    runID: s.runID,
    idea: s.idea,
    status: s.status,
    totalCost: number(s.totalCost),
    currentStage: s.currentStage,
    awaitingGate: s.awaitingGate,
    badge: runStatusBadge(s.status),
  }))
}

export type DryRunReport = {
  ok: boolean
  departments: number
  stages: number
  agentCount: number
  issues: string[]
}

/**
 * Pure `--dry-run` preflight (Task 8.3): mirrors `handleInit`'s load -> validate -> crossCheck
 * sequence (`cli/cmd/org.ts`) but takes an already-loaded org + agents map instead of doing its own
 * I/O, so it can be unit-tested with in-memory fixtures. Callers load `org` via
 * `OrgSchema.loadOrganization` (which already throws on structural/validate errors before returning
 * -- see schema.ts) and `agents` via `ConfigAgent.load`; re-running `validate` here is what lets this
 * stay a general, pure function testable independent of that load path (e.g. with a hand-built
 * invalid org, as `test/kilocode/cockpit/run-list.test.ts` does).
 */
export function dryRunReport(
  org: OrgSchema.Organization,
  agents: Record<string, { mode?: string; subordinates?: readonly string[] }>,
): DryRunReport {
  const issues = [...OrgSchema.validate(org), ...OrgSchema.crossCheck(org, agents)]
  return {
    ok: issues.length === 0,
    departments: Object.keys(org.departments).length,
    stages: org.pipeline.length,
    agentCount: Object.keys(agents).length,
    issues,
  }
}
// kilocode_change end
