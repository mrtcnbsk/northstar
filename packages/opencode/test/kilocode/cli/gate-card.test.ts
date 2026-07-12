// kilocode_change - new file
// Task 7.4 (EPIC 7 / TUI Chat): RED tests for the pure gate-detection parser behind the
// inline gate card. Fixtures mirror the REAL org_advance output shape built by
// `gatePayload`/`result` in src/kilocode/organization/tools.ts:
//   - `result(title, body)` JSON.stringifies `body` (2-space indent) into ToolStateCompleted.output.
//   - gatePayload(gate) => { stage, deliverable, ...(note ? { budget_note } : {}), instructions }.
//   - The standalone gate: `{ action: "human_gate", ...gatePayload(gate) }`.
//   - The informational fan-out rider: `{ action: "run_tasks", tasks, pending_gate: gatePayload(gate), then }`.
// Neither shape includes a `run_id` key today (org_advance's output never echoes the run
// back) - parseGate still maps `run_id` -> `runID` defensively/for forward-compat, so a
// dedicated fixture exercises that mapping even though it's not what production emits yet.
import { describe, test, expect } from "bun:test"
import { parseGate } from "@/kilocode/cli/cmd/tui/gate-card"

function completed(output: string) {
  return { tool: "org_advance", state: { status: "completed", output } }
}

const HUMAN_GATE_OUTPUT = JSON.stringify(
  {
    action: "human_gate",
    stage: "review",
    deliverable: "/Users/dev/proj/.kilocode/org-runs/run_abc123/review.md",
    instructions:
      "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision.",
  },
  null,
  2,
)

const HUMAN_GATE_WITH_BUDGET_NOTE_OUTPUT = JSON.stringify(
  {
    action: "human_gate",
    stage: "backend",
    deliverable: "/Users/dev/proj/.kilocode/org-runs/run_abc123/backend.md",
    budget_note: "cumulative spend exceeded escalation threshold ($42.50 of $50 run budget)",
    instructions:
      "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision. This gate was triggered by budget: cumulative spend exceeded escalation threshold ($42.50 of $50 run budget). Tell the user the cumulative spend before asking for a decision.",
  },
  null,
  2,
)

const PENDING_GATE_ON_RUN_TASKS_OUTPUT = JSON.stringify(
  {
    action: "run_tasks",
    tasks: [
      {
        stage: "frontend",
        subagent_type: "frontend-chief",
        description: "frontend stage",
        prompt: "Build the SwiftUI views per the UX package.",
      },
    ],
    pending_gate: {
      stage: "review",
      deliverable: "/Users/dev/proj/.kilocode/org-runs/run_abc123/review.md",
      instructions:
        "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision.",
    },
    then:
      'Spawn ALL of these tasks in the SAME turn as parallel `task` tool calls. NOTE: stage "review" is ALSO awaiting a human gate (pending_gate); it will be surfaced as a human_gate to resolve once these tasks settle.',
  },
  null,
  2,
)

const RUN_TASKS_OUTPUT = JSON.stringify(
  {
    action: "run_tasks",
    tasks: [
      {
        stage: "planning",
        subagent_type: "planning-chief",
        description: "planning stage",
        prompt: "Draft the technical plan.",
      },
    ],
    then: "Spawn ALL of these tasks in the SAME turn as parallel `task` tool calls.",
  },
  null,
  2,
)

const WAITING_OUTPUT = JSON.stringify(
  {
    action: "waiting",
    then: "one or more stages are still running; when their tasks return call org_advance again with their task_results",
  },
  null,
  2,
)

const DONE_OUTPUT = JSON.stringify(
  { action: "done", note: "pipeline complete; present the final package to the user" },
  null,
  2,
)

const HALTED_OUTPUT = JSON.stringify({ action: "halted", reason: "run budget exceeded" }, null, 2)

const RESUME_CHIEF_OUTPUT = JSON.stringify(
  {
    action: "resume_chief",
    stage: "backend",
    reason: "chief session timed out",
    resume_task_id: "ses_xyz",
    then: "when the chief's task returns, call org_advance again with task_id set to the task session id",
  },
  null,
  2,
)

describe("parseGate", () => {
  test("extracts stage/deliverable from a standalone human_gate output", () => {
    const card = parseGate(completed(HUMAN_GATE_OUTPUT))
    expect(card).toEqual({
      stage: "review",
      deliverable: "/Users/dev/proj/.kilocode/org-runs/run_abc123/review.md",
      budgetNote: undefined,
      runID: undefined,
    })
  })

  test("extracts budget_note -> budgetNote when the gate was budget-triggered", () => {
    const card = parseGate(completed(HUMAN_GATE_WITH_BUDGET_NOTE_OUTPUT))
    expect(card).toEqual({
      stage: "backend",
      deliverable: "/Users/dev/proj/.kilocode/org-runs/run_abc123/backend.md",
      budgetNote: "cumulative spend exceeded escalation threshold ($42.50 of $50 run budget)",
      runID: undefined,
    })
  })

  test("extracts run_id -> runID when present in the gate body (forward-compat; not emitted today)", () => {
    const output = JSON.stringify(
      {
        action: "human_gate",
        stage: "review",
        deliverable: "/tmp/review.md",
        run_id: "run_abc123",
        instructions: "...",
      },
      null,
      2,
    )
    const card = parseGate(completed(output))
    expect(card?.runID).toBe("run_abc123")
  })

  test("extracts the gate nested under pending_gate on a run_tasks batch", () => {
    const card = parseGate(completed(PENDING_GATE_ON_RUN_TASKS_OUTPUT))
    expect(card).toEqual({
      stage: "review",
      deliverable: "/Users/dev/proj/.kilocode/org-runs/run_abc123/review.md",
      budgetNote: undefined,
      runID: undefined,
    })
  })

  test("returns undefined for a non-org_advance tool", () => {
    const part = { tool: "read", state: { status: "completed", output: HUMAN_GATE_OUTPUT } }
    expect(parseGate(part)).toBeUndefined()
  })

  test("returns undefined for org_advance action: run_tasks (no pending_gate)", () => {
    expect(parseGate(completed(RUN_TASKS_OUTPUT))).toBeUndefined()
  })

  test("returns undefined for org_advance action: waiting", () => {
    expect(parseGate(completed(WAITING_OUTPUT))).toBeUndefined()
  })

  test("returns undefined for org_advance action: done", () => {
    expect(parseGate(completed(DONE_OUTPUT))).toBeUndefined()
  })

  test("returns undefined for org_advance action: halted", () => {
    expect(parseGate(completed(HALTED_OUTPUT))).toBeUndefined()
  })

  test("returns undefined for org_advance action: resume_chief", () => {
    expect(parseGate(completed(RESUME_CHIEF_OUTPUT))).toBeUndefined()
  })

  test("returns undefined for a non-completed state (pending)", () => {
    const part = { tool: "org_advance", state: { status: "pending", output: HUMAN_GATE_OUTPUT } }
    expect(parseGate(part)).toBeUndefined()
  })

  test("returns undefined for a non-completed state (running)", () => {
    const part = { tool: "org_advance", state: { status: "running" } }
    expect(parseGate(part)).toBeUndefined()
  })

  test("returns undefined for a non-completed state (error)", () => {
    const part = { tool: "org_advance", state: { status: "error" } }
    expect(parseGate(part)).toBeUndefined()
  })

  test("does not throw and returns undefined for malformed (non-JSON) output", () => {
    const part = completed("not json at all {{{")
    expect(() => parseGate(part)).not.toThrow()
    expect(parseGate(part)).toBeUndefined()
  })

  test("returns undefined for valid JSON that isn't an object (e.g. a JSON string)", () => {
    const part = completed(JSON.stringify("just a string"))
    expect(parseGate(part)).toBeUndefined()
  })

  test("returns undefined for valid JSON with no action/pending_gate at all", () => {
    const part = completed(JSON.stringify({ foo: "bar" }))
    expect(parseGate(part)).toBeUndefined()
  })

  test("returns undefined when state/output/tool are entirely missing", () => {
    expect(parseGate({})).toBeUndefined()
    expect(parseGate({ tool: "org_advance" })).toBeUndefined()
    expect(parseGate({ tool: "org_advance", state: {} })).toBeUndefined()
  })
})
