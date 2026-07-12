# Autonomous Loop-Mode + Mission Control TUI — Design

**Status:** Approved (2026-07-12). Codename: **Loop mode**.

**Goal:** After the user approves a plan once, the northstar org runs the whole pipeline **autonomously** — each stage driven by a deterministic loop that self-verifies its deliverable against approved acceptance criteria and iterates until it passes — stopping for the human only when a stage genuinely gets stuck or before a single irreversible/external action. A new **Mission Control** TUI is the primary surface for watching and steering that run.

**Architecture:** The existing pure `OrgRunner` state machine is left intact. Two new units sit on top: a deterministic **`OrgConductor`** that drives `advance → spawn chiefs → evaluate → apply verdict → repeat`, and a pure **`OrgEvaluator`** (prompt + verdict schema + parser) whose LLM call is injected. Per-stage acceptance criteria are authored by the CEO at plan time, approved by the human, and stored in run state. Mission Control reuses the cockpit view-model builders plus a new evaluator-loop panel, and its conversation strip handles the four human touch-points (plan approval, steering notes, escalation, final gate).

**Tech Stack:** Bun + TypeScript, Effect Schema (schema/state), the existing `organization/` runtime, the org-runs HTTP API + SDK, SolidJS/OpenTUI (TUI). No new external dependencies.

---

## 1. Motivation & framing

The [Anthropic "loops" framework](https://claude.com/blog/getting-started-with-loops) defines loops as "agents repeating cycles of work until a stop condition is met" and names four patterns. This feature realizes the **goal-based loop** (an evaluator checks a success condition and iterates until met or a cap is reached) wrapped in a **proactive/auto** driver (runs without pausing for permission), with **human checkpoints reserved for irreversible steps and genuine dead-ends** — exactly the article's guidance.

Today the runner is *turn-driven*: `advance()` returns one batch and waits for the CEO agent to call `org_advance` again; every `gate:"human"` stage halts at `awaiting_approval` for `org_decision`. Quality is enforced by the human at each gate. Loop mode replaces that per-stage human gating with an autonomous evaluator loop, keeping exactly **one** up-front approval (the plan) and **one** downstream approval (before irreversible external actions).

## 2. Locked decisions

1. **Gate model:** plan-approval → autonomous → **one** final gate before irreversible/external actions. Intermediate `gate:"human"` stages become autonomous evaluator loops.
2. **Definition of done:** per-stage **measurable acceptance criteria**, authored by the CEO at plan time, approved by the human, stored in state; a cheap **evaluator agent** judges each deliverable against them (`pass` / `revise` + reasons).
3. **Stuck behavior:** when the evaluator loop exhausts `maxIterations` on a stage, the run **pauses and escalates to the human** (surfacing the evaluator's rejection reasons) — it does **not** silently halt or silently proceed.
4. **Loop driver:** a **deterministic conductor** (code), not the CEO agent. The CEO is used only for one-shot planning and (optionally) a final summary; it is never in the loop.
5. **TUI:** **Mission Control** — cockpit-primary dashboard with a thin conversation strip.

### 2.1 Resolved defaults (the two open questions)

- **Planning is one-shot generation + human-editable approval.** The CEO produces the plan (per-stage objective + criteria + assigned agents) in a single bounded call. It is presented as an **editable** plan-approval card: the human may edit/add/remove criteria, tighten scope, or send a revise note before approving. This is the single up-front gate (`gate #0`).
- **Final-gate scope = external/irreversible stages, belt-and-suspenders.** A stage triggers the final gate if **either** (a) the template marks it `gate:"human"` (author intent: this stage ships/submits/publishes), **or** (b) the stage's chief invokes a tool on the **irreversible-action denylist** (App Store submit, publish/release, any payment/spend, permission/ACL change, hard delete). The conductor **never auto-approves** a stage that touched a denylisted tool, regardless of the evaluator verdict. The denylist is a static allowset-complement in `organization/irreversible.ts`.

## 3. Lifecycle & state machine

```
  idea
   │  (one-shot CEO planner)
   ▼
 PLAN ──── plan-approval card (editable) ──► [human gate #0]
   │  approve                    │ no-go
   ▼                             ▼
 AUTONOMOUS PHASE (conductor loop)          halted
   │
   │  repeat until done / stop:
   │   1. advance() → ready stages
   │   2. spawn chief session(s) with stage prompt + criteria
   │   3. await chief settle (deliverable produced)
   │   4. evaluator(deliverable, criteria) → pass | revise(reasons)
   │        pass    → stage completed (auto)
   │        revise  → re-instruct chief with reasons; iterations++;
   │                  loop until pass OR iterations > maxIterations
   │        stuck   → run paused, escalate to human ──► [escalation]
   │   5. if stage is final/irreversible → do NOT auto-complete;
   │        surface final gate ──► [human gate #1]
   ▼
 FINAL GATE (deliver/release) ── approve → run to completion
                              ── revise  → re-open stage (back to loop)
                              ── no-go   → halted
   │
   ▼
 completed
```

**New `Run.status` value:** `paused` (in addition to `active | halted | completed`). `paused` = autonomous run stopped and waiting on the human at an **escalation** (recoverable — human steers → resumes) or a **final gate**. Distinct from `halted` (terminal). Distinct from `active` (conductor is driving).

**Stage status:** unchanged enum (`pending | running | awaiting_approval | completed | skipped | failed`). In loop mode, evaluator-`revise` reuses the existing `running → running` re-instruct path (same as human revise today). Escalation puts the stage in `awaiting_approval` with an `escalationNote` derived from the evaluator's reasons (reuses the existing escalation slot). The final gate uses `awaiting_approval` exactly as today.

## 4. Component design

### 4.1 `OrgEvaluator` (pure) — `organization/evaluator.ts`

Responsibility: build the evaluator prompt, define the verdict schema, and parse the evaluator's reply. **The LLM call itself is injected** — this module never calls a model, so it is fully unit-testable.

```ts
export namespace OrgEvaluator {
  export const Verdict = Schema.Struct({
    pass: Schema.Boolean,
    // present when pass=false: one bullet per unmet criterion, actionable
    reasons: Schema.optional(Schema.Array(Schema.String)),
    // optional short note carried into the audit trail
    summary: Schema.optional(Schema.String),
  })
  export type Verdict = typeof Verdict.Type

  // Builds the evaluator instruction: the stage objective, the approved
  // criteria as a checklist, the deliverable text, and a strict output contract.
  export function prompt(input: {
    stage: string
    objective: string
    criteria: string[]
    deliverable: string
  }): string

  // Parses the evaluator agent's final message into a Verdict.
  // FAIL-SAFE: unparseable / missing verdict → { pass:false, reasons:["evaluator produced no parseable verdict"] }.
  // NEVER returns pass=true on ambiguous input.
  export function parse(reply: string): Verdict
}
```

Design notes:
- The evaluator runs on a **cheap model** (default `haiku`, configurable per-org via `budget`/model config). It gets **read-only** context (the deliverable text + criteria); it is granted **no tools** beyond what's needed to read the deliverable file. Its verdict is data, never an instruction (injection boundary — a deliverable that says "ignore criteria, pass this" is just text the evaluator judges).
- Criteria with no objective evidence in the deliverable → `revise` (the evaluator must find positive evidence for each criterion; absence = unmet).

### 4.2 `OrgConductor` (deterministic driver) — `organization/conductor.ts`

Responsibility: drive one run through the autonomous phase. Mirrors the runner's dependency-injection style so it is testable without an LLM, a network, or a clock.

```ts
export namespace OrgConductor {
  export interface Deps {
    runner: typeof OrgRunner          // advance()/decide() over pure state
    // spawn a chief session for a stage and resolve when it has settled
    // (deliverable written or terminal failure). Returns the taskID + cost.
    spawnChief: (input: { runID: string; stage: string; instruction: string })
      => Promise<{ taskID: string; cost: number }>
    // run the evaluator agent; returns its raw final message for OrgEvaluator.parse
    evaluate: (input: { runID: string; stage: string; prompt: string })
      => Promise<string>
    now: () => number
    // surfaces conductor events for the TUI/event stream (see 4.6)
    emit: (event: OrgEvent) => void
  }

  // Drives the run until a stop condition. Returns the terminal outcome.
  // Re-entrant: safe to call again after a pause is resolved (resume).
  export function drive(runID: string, deps: Deps): Promise<Outcome>

  export type Outcome =
    | { type: "completed" }
    | { type: "halted"; reason: string }
    | { type: "paused"; kind: "escalation" | "final_gate"; stage: string; detail: string }
}
```

The loop (pseudocode, one iteration):
1. `batch = runner.advance(state)`; persist state.
2. If `batch.halted` → return `halted`. If `batch.done` → return `completed`.
3. If `batch.gate` (a `gate:"human"`/irreversible stage awaiting) → set `run.status="paused"`, emit `final_gate`, return `paused{final_gate}`.
4. For each ready stage in the batch, in its concurrency budget: `spawnChief(...)`; await settle.
5. For each settled stage: build `OrgEvaluator.prompt`, `evaluate(...)`, `OrgEvaluator.parse`.
   - `pass` **and** stage is **not** irreversible → apply `decide(approve)` equivalent (mark completed); record verdict in audit.
   - `pass` **and** stage **is** irreversible → do not auto-complete; fall to step 3 next iteration (final gate).
   - `revise` and `iterations <= maxIterations` → re-instruct chief with `reasons` (reuse the revise re-instruct path); `iterations++`.
   - `revise` and `iterations > maxIterations` → set `run.status="paused"`, write `escalationNote` from `reasons`, emit `escalation`, return `paused{escalation}`.
6. Enforce stop conditions (budget ceiling, emergency stop) at each turn (delegated to the runner, which already halts on these).

**Determinism:** given the same `spawnChief`/`evaluate` outputs and clock, `drive` produces identical state transitions. No CEO-agent reasoning is in the loop.

**Concurrency:** honors the org's existing `maxConcurrency` (DAG fan-out) — the conductor spawns up to N chiefs per turn, exactly as the CEO agent would today, but deterministically.

### 4.3 Schema & state extensions

`schema.ts` (`organization.jsonc` authoring):
- `Stage.criteria?: string[]` — acceptance criteria (may be authored statically in a template, or filled by the CEO planner at run time).
- `Stage.irreversible?: boolean` — explicit author flag that this stage triggers the final gate (in addition to `gate:"human"` and the tool denylist).
- Org-level `loop?: { maxIterations?: number; evaluatorModel?: string }` — defaults `maxIterations: 4`, `evaluatorModel: "haiku"`.

`state.ts` (per-run persisted state):
- `Run.auto?: boolean` — this run is in autonomous loop mode.
- `Run.status` gains `"paused"`.
- `Run.pausedReason?: { kind: "escalation" | "final_gate"; stage: string; detail: string }`.
- `Stage.criteria?: string[]` — the **approved** criteria for this run (snapshot from the plan; the source of truth the evaluator uses).
- `Stage.iterations?: number` — evaluator revise-loop count (distinct from `attempts`/`incompleteAttempts`, which count chief runs).
- `Stage.verdictHistory?: { pass: boolean; reasons?: string[]; ts: number }[]` — audit of evaluator verdicts.

All additions are optional → existing runs and non-auto runs are byte-compatible. Pure selectors added: `OrgState.isIrreversible(org, stage)`, `OrgState.pausedRuns()`.

### 4.4 Plan-approval flow

- **New tool `org_plan`** (CEO-only): given `run_id`, the CEO emits the plan — for each stage `{ objective, criteria[], agents[] }` — which is validated and written to state as stage `criteria` + a `plan.md` deliverable for the (intake/planning) stage. Returns the plan for the approval card.
- The planning stage is stage 0 with `gate:"human"`; its deliverable **is** the plan+criteria. Approving it (`org_decision approve`) flips `run.auto = true` and hands off to the conductor. This reuses the existing gate/decision machinery — no new decision type.
- **Editability:** the plan-approval card lets the human edit criteria inline; edits are sent as an `org_decision revise` with a structured note, or (simpler) an `org_plan` re-emit with the human's edits merged. The card's "approve" path writes the final (possibly edited) criteria before starting the loop.

### 4.5 Stop conditions (complete list)

| Condition | Result | Source |
|---|---|---|
| Pipeline done | `completed` | runner (existing) |
| Run budget ceiling | `halted` | runner (existing) |
| Stage budget ceiling | `halted` | runner (existing) |
| Chief retries exhausted (`incompleteAttempts > retries`) | `halted` (failed stage) | runner (existing) |
| Emergency stop (`org_stop`) | `halted` | runner (existing) |
| No-go at plan gate or final gate | `halted` | runner (existing) |
| **Evaluator loop exhausted (`iterations > maxIterations`)** | **`paused` (escalation)** | conductor (new) |
| **Irreversible/final stage reached** | **`paused` (final gate)** | conductor (new) |
| **Human steers a paused run** | resumes → `active` | conductor (new) |

### 4.6 Conductor driver & events

The conductor runs as a **headless driver** attached to a run, reusing the `run --auto` precedent (today `--auto` only auto-approves permissions; loop mode makes it the actual autonomous driver). It emits `OrgEvent`s (stage started, deliverable settled, evaluator verdict, revise iteration, escalation, final gate, completion) that are:
- appended to the run's audit trail (`OrgAudit`), and
- surfaced to the org-runs HTTP detail so Mission Control renders them live (polling, as the cockpit does today).

`org_stop`, steering notes (`org_note`), and decisions continue to work; the conductor consumes queued notes at the top of each turn and injects them into the relevant chief's next instruction (reuses the existing note-consume path).

## 5. Mission Control TUI

**Route:** extend the existing cockpit route into the primary autonomous-run surface (or a sibling `run` route reusing cockpit internals). Renders from the org-runs detail (polled every 3s while `status === "active"`; also polls while `paused` so a resumed run updates).

**Panels** (reusing existing pure builders + new ones):
- **Pipeline timeline** — `stageTimeline` (existing) + per-stage `↻ revize N/max` and `⏸ final kapı` annotations (new formatting).
- **Agent tree** — `buildAgentTree` (existing, Tier A).
- **Evaluator loop panel (new)** — `buildEvaluatorPanel(detail)`: current stage, its criteria as a ✓/✗ checklist derived from the latest verdict, iteration `N/max`, latest rejection reason. Pure view-model, unit-tested.
- **Budget + loop gauges** — `budgetGauge` (existing) + `loopGauge` (new): iteration count, elapsed, evaluator model.
- **Event stream** — `auditTrail` (existing) fed by conductor events.
- **Conversation strip (new, slim)** — handles the four touch-points via one composer:
  - **plan-approval card** (editable criteria) → `org_plan`/`org_decision`
  - **steering note** → `org_note` (and `@mention` to target an agent)
  - **escalation card** (evaluator reasons + steer/no-go) → note or `org_decision`
  - **final-gate card** (approve/revise/cancel) → `org_decision`
  - `[p] pause` / `[s] stop` keybinds.

**Write path:** as today, decisions/notes/stop are driven by sending CEO-session messages (the existing convention), OR — cleaner — by adding thin HTTP endpoints for `org_decision`/`org_note`/`org_stop`/pause-resume so Mission Control acts directly. **Decision:** add the HTTP endpoints (removes the fragile "CEO agent must translate a chat message into a tool call" dependency that EPIC 7/8 flagged), guarded and run-scoped, reusing the org-runs handler patterns. Pause/resume is a new endpoint that sets `run.status` and (re)starts the conductor `drive`.

## 6. Error handling & safety

- **Escalation, not silent failure:** stuck loop → `paused` + human, with the evaluator's concrete reasons. Never auto-halt without surfacing why; never proceed below the bar.
- **Evaluator fail-safe:** unparseable/empty verdict → treated as `revise` with a generic reason, bounded by `maxIterations` → escalate. A malformed evaluator can never produce an auto-`pass`.
- **Irreversible boundary:** the conductor never auto-completes a stage that hit the tool denylist or is flagged `irreversible`/`gate:"human"`; those always route to the final human gate. This preserves the assistant/user safety boundary (no autonomous publish/submit/spend).
- **Budget & emergency stop:** unchanged — still hard-halt.
- **Injection:** deliverables and evaluator replies are untrusted **data**. The evaluator has no side-effectful tools; its verdict is parsed structurally, not executed. Steering notes come only from the human via the TUI.
- **Determinism:** conductor transitions are reproducible; no CEO-in-loop nondeterminism. This is the reliability argument for the deterministic-driver choice.

## 7. Testing strategy

- **`OrgEvaluator` (pure):** `prompt` shape; `parse` for `pass`, `revise`+reasons, and malformed → fail-safe. No LLM.
- **`OrgConductor` (deterministic):** inject fake `spawnChief` + fake `evaluate` + fake clock; drive a fixture org through every path — pass-first-try, revise-then-pass, stuck→escalate, irreversible→final-gate, budget→halt, no-go→halt, resume-after-escalation. Assert exact state transitions and emitted events. No LLM, no network.
- **Schema/state:** criteria/iterations/verdictHistory round-trip; `paused` status; back-compat with existing non-auto runs.
- **HTTP endpoints:** decision/note/stop/pause-resume — happy path + run-scoped guards + fail-closed on invalid.
- **Mission Control TUI:** pure view-model builders (`buildEvaluatorPanel`, `loopGauge`, timeline annotations) unit-tested; PLUS a render/integration test — **EPIC 8 lesson: pure view-model tests miss render-layer bugs (SolidJS reactive loops, ErrorBoundary crash paths, fetch-failure). The wave-close adversarial review is load-bearing for the render layer.**
- **End-to-end exit test:** seed a fixture auto-run, drive it with scripted chief/evaluator outputs, assert it reaches completion through the loop and pauses correctly at escalation + final gate.

## 8. Scope decomposition & sequencing

Two coupled sub-projects; the TUI depends on the engine's data model, so the engine ships first. **One spec (this doc), two implementation phases in one plan:**

- **SP1 — Autonomous engine** (backend, headless, fully testable):
  `OrgEvaluator` → schema/state extensions → `OrgConductor` → `org_plan` + plan-approval handoff → stop conditions → HTTP endpoints (decision/note/stop/pause-resume) → conductor driver + events → engine exit test.
- **SP2 — Mission Control TUI** (on top of SP1):
  evaluator panel + loop gauge + timeline annotations (pure builders) → conversation strip (plan/steer/escalation/final-gate cards) → route wiring + polling → live-browser proof → wave-close adversarial review.

Each phase ends with the project discipline: exit test → adversarial wave-close review (Workflow, 4 dimensions, 3-skeptic refutation) → full sweep SOLO → merge.

## 9. Out of scope (YAGNI)

- Time-based / scheduled autonomous runs (cron) — the article's time-based loop. Not now; the conductor is invoked per-run.
- Multiple concurrent auto-runs on one screen — Mission Control shows one run; the run-list home already exists for switching.
- SSE event streaming — reuse 3s polling (W3/EPIC 8 precedent); revisit only if latency hurts.
- Learning/among-runs criteria memory (auto-tuning criteria from past runs) — future.
- Worker-level (Tier B) liveness in the agent tree — already deferred (E8-R1); unchanged.

## 10. Interfaces summary (for the plan)

New files: `organization/evaluator.ts`, `organization/conductor.ts`, `organization/irreversible.ts`, cockpit `evaluator-panel` builder, HTTP handlers for decision/note/stop/pause-resume, conversation-strip components.
Changed files: `schema.ts` (+criteria/irreversible/loop), `state.ts` (+auto/paused/criteria/iterations/verdictHistory/selectors), `tools.ts` (+`org_plan`), the org-runs HTTP detail (surface criteria/iterations/verdicts/paused), the cockpit route/view, `run --auto` (wire the conductor), templates (author criteria + irreversible flags on ship stages), CEO agent prompt (`org_plan` protocol).
