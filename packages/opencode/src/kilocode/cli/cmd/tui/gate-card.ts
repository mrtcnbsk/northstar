// kilocode_change - new file
// Task 7.4 (EPIC 7 / TUI Chat): pure gate-detection parser behind the inline gate card.
//
// When an org pipeline stage hits `gate:"human"`, the CEO's `org_advance` tool call
// returns a completed ToolPart whose `state.output` is a JSON string (see `result()` in
// src/kilocode/organization/tools.ts, which JSON.stringifies the body with 2-space
// indent). Two shapes carry a gate, both built by the SAME `gatePayload(gate)` helper
// (~L287-298 in tools.ts): `{ stage, deliverable, budget_note? }`.
//   - The standalone gate: `{ action: "human_gate", ...gatePayload(gate) }` (~L356).
//   - The informational rider on a parallel fan-out: `{ action: "run_tasks", tasks,
//     pending_gate: gatePayload(gate), then }` (~L326) - a co-existing branch that is
//     ALSO awaiting a decision while other stages are still running.
// Neither shape echoes `run_id` back in the OUTPUT today (org_advance's output never
// includes it - the CEO already knows the run_id from context). But org_advance's INPUT
// always carries `run_id` (`AdvanceParameters` in tools.ts requires it), and
// `ToolStateCompleted.input` (src/session/message-v2.ts) is a populated record of the
// tool-call args for a completed ToolPart. So `runID` is sourced primarily from
// `state.input.run_id` - the REAL, always-present disambiguator - falling back to any
// `run_id` embedded directly in the parsed output (forward-compat, in case a future
// payload adds it there too).
//
// kilocode_change - Finding 3 (HIGH, wave-close review): with two concurrent runs each
// showing a gate card, `card.runID` being undefined meant the a/n/r message degraded to
// "approve run the current run" - no run_id, no stage - so the CEO could resolve the
// decision against the WRONG run. Sourcing runID from the tool INPUT (always populated)
// fixes that; see routes/session/gate-card.tsx for where runID + stage are embedded in
// the sent message.
//
// This module does ONE thing: detect + extract, plus the pure a/n/r message builder
// (`gateMessage`) so the run_id/stage-embedding is unit-testable without rendering the
// component. It never renders anything and never touches the network - see
// routes/session/gate-card.tsx for the a/n/r card that wraps this and
// routes/session/index.tsx for where it's wired into the ToolPart renderer.

export interface GateCard {
  runID?: string
  stage: string
  deliverable?: string
  budgetNote?: string
}

interface GatePartLike {
  tool?: string
  state?: {
    status?: string
    output?: string
    input?: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function extract(gate: Record<string, unknown>): GateCard | undefined {
  const stage = readString(gate.stage)
  if (!stage) return undefined
  return {
    stage,
    deliverable: readString(gate.deliverable),
    budgetNote: readString(gate.budget_note),
    // kilocode_change - forward-compat fallback only; the real source is state.input.run_id
    // below, applied after extract() returns (org_advance's output doesn't emit this today).
    runID: readString(gate.run_id),
  }
}

export function parseGate(part: GatePartLike): GateCard | undefined {
  if (part.tool !== "org_advance") return undefined
  if (part.state?.status !== "completed") return undefined
  const output = part.state.output
  if (!output) return undefined

  let body: unknown
  try {
    body = JSON.parse(output)
  } catch {
    // Malformed/non-JSON output - never throw, just report "no gate here".
    return undefined
  }
  if (!isRecord(body)) return undefined

  let card: GateCard | undefined
  if (body.action === "human_gate") card = extract(body)
  else if (isRecord(body.pending_gate)) card = extract(body.pending_gate)
  if (!card) return undefined

  // kilocode_change - Finding 3 fix: source runID from the org_advance tool CALL's own
  // input (the real run_id the CEO passed in), which takes priority over any run_id
  // extract() may have pulled from the output above.
  const inputRunID = readString(part.state?.input?.run_id)
  if (inputRunID) card.runID = inputRunID
  return card
}

export type GateDecision = "approve" | "no-go" | "revise"

/** kilocode_change - Finding 3 fix: falls back to a human-readable placeholder ONLY when
 * runID is genuinely absent (both the tool input and the output lacked a run_id) - in
 * normal operation `card.runID` is now populated from `state.input.run_id` by parseGate
 * above, so the sent message names the exact run. */
function runRef(card: GateCard): string {
  return card.runID ?? "the current run"
}

/** kilocode_change - Finding 3 fix: the a/n/r message sent to the CEO as a chat prompt
 * (see routes/session/gate-card.tsx's `send`). Always embeds BOTH the run and the stage
 * so the decision is unambiguous even with multiple concurrent runs/gates on screen -
 * `org_decision` itself only takes `{run_id, decision, note}` (no stage param), so the
 * stage here is advisory context for the CEO/user, while the run_id is the load-bearing
 * disambiguator. Extracted as a pure function so this is unit-testable without rendering
 * the component. */
export function gateMessage(card: GateCard, decision: "approve"): string
export function gateMessage(card: GateCard, decision: "no-go"): string
export function gateMessage(card: GateCard, decision: "revise", note: string): string
export function gateMessage(card: GateCard, decision: GateDecision, note?: string): string {
  const run = runRef(card)
  const stage = card.stage
  switch (decision) {
    case "approve":
      return `approve run ${run} (stage "${stage}")`
    case "no-go":
      return `reject run ${run} (stage "${stage}", no-go)`
    case "revise":
      return `revise run ${run} (stage "${stage}"): ${note}`
  }
}
