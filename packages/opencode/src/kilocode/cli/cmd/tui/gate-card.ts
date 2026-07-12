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
// Neither shape echoes `run_id` back today (org_advance's output never includes it - the
// CEO already knows the run_id from context), but `run_id` -> `runID` is still mapped
// defensively/for forward-compat if a future payload adds it.
//
// This module does ONE thing: detect + extract. It never renders anything and never
// touches the network - see routes/session/gate-card.tsx for the a/n/r card that wraps
// this and routes/session/index.tsx for where it's wired into the ToolPart renderer.

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

  if (body.action === "human_gate") return extract(body)
  if (isRecord(body.pending_gate)) return extract(body.pending_gate)
  return undefined
}
