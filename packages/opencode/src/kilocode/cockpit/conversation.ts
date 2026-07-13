// kilocode_change - new file
/** Pure card selection and @mention parsing for the Mission Control conversation strip. */
import { formatElapsed } from "./cockpit-view"
export type ConversationVerdict = { pass: boolean; reasons?: string[]; ts: string | number }

export type ConversationStageView = {
  stage: string
  status: string
  criteria?: string[]
  verdictHistory?: ConversationVerdict[]
}

export type ConversationDetailView = {
  run: { status: string; auto?: boolean; pausedReason?: { kind: string; stage: string; detail: string } | null }
  stages: ConversationStageView[]
}

export type ConversationCard =
  | { kind: "none" }
  | { kind: "plan"; stage: string; criteria: string[] }
  | { kind: "escalation"; stage: string; reasons: string[]; detail: string }
  | { kind: "final_gate"; stage: string; detail: string }

export type CompletionDetailView = {
  run: { status: string; createdAt: string }
  totalCost: number | "NaN" | "Infinity" | "-Infinity"
  stages: readonly {
    stage: string
    status: string
    completedAt?: string | null
    deliverablePath?: string
  }[]
}

export type MissionCompletion = {
  title: "Mission complete"
  totalCost: number
  elapsed: string
  deliverables: { stage: string; path: string }[]
  action: "Return to Chat"
}

export function missionCompletion(detail: CompletionDetailView): MissionCompletion | undefined {
  if (detail.run.status !== "completed") return
  const started = Date.parse(detail.run.createdAt)
  const finished = Math.max(
    Number.isNaN(started) ? 0 : started,
    ...detail.stages.map((stage) => Date.parse(stage.completedAt ?? "")).filter((time) => !Number.isNaN(time)),
  )
  return {
    title: "Mission complete",
    totalCost: typeof detail.totalCost === "number" && Number.isFinite(detail.totalCost) ? detail.totalCost : 0,
    elapsed: formatElapsed(Number.isNaN(started) ? 0 : finished - started),
    deliverables: detail.stages
      .filter((stage) => stage.status === "completed" && stage.deliverablePath)
      .map((stage) => ({ stage: stage.stage, path: stage.deliverablePath! })),
    action: "Return to Chat",
  }
}

export function conversationCard(detail: ConversationDetailView): ConversationCard {
  const { run } = detail
  if (run.status === "paused" && run.pausedReason) {
    const { kind, stage, detail: reason } = run.pausedReason
    if (kind === "escalation") {
      const record = detail.stages.find((item) => item.stage === stage)
      const latest = record?.verdictHistory?.at(-1)
      return {
        kind: "escalation",
        stage,
        reasons: latest && !latest.pass ? (latest.reasons ?? []) : [],
        detail: reason,
      }
    }
    if (kind === "final_gate") return { kind: "final_gate", stage, detail: reason }
  }
  if (run.auto !== true) {
    const gate = detail.stages.find((stage) => stage.status === "awaiting_approval")
    if (gate) return { kind: "plan", stage: gate.stage, criteria: gate.criteria ?? [] }
  }
  return { kind: "none" }
}

const MENTION = /^@([A-Za-z0-9._-]+)\s+([\s\S]+)$/

export function parseMention(input: string): { target: string; text: string } {
  const trimmed = input.trim()
  const match = MENTION.exec(trimmed)
  if (match) {
    const [, target, text] = match
    if (target && text) return { target, text: text.trim() }
  }
  return { target: "*", text: trimmed }
}
