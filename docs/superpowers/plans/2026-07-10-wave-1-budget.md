# Wave 1 — Budget Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Branch: `feat/wave-1-budget` (off main; W1.0 + W1.0b already landed — org write path restored). `bun` at `~/.bun/bin`; never stage `bun.lock`; broad sweeps via `bun run script/test-runner.ts`; clean `"$(getconf DARWIN_USER_TEMP_DIR)"opencode-test-*` after runs.

**Goal:** Make unattended org runs financially safe: per-stage/per-run cost ceilings that halt, a threshold that auto-injects a human gate, a config-driven approval matrix, pre-flight cost prediction, and cost-aware model fallback. Nothing autonomous is safe to run without this (dossier F1).

**Sources:** [master plan](../specs/2026-07-10-master-plan.md) W1 · [dossier](../specs/2026-07-10-master-plan-dossier.md) §C · owner-approved defaults: run $50, stage $15, escalation $10, retries 2.

**Foundation already present:** per-session `costs` map on `OrgState.Stage` + `stageCost()` + `status().totalCost` (W0.1); `KiloCostPropagation.childCost` (cost lookup, injected as `costOf` into the runner); approvals audit + `org_stop` (W0.5); bidirectional pipeline invariant (W0.4).

**Protocol:** per task — fresh implementer, spec review, quality review; Important findings fixed by same implementer and re-reviewed; TDD (failing test first, real output). Each task commits separately.

---

### W1.1 — Budget config + schema

**Files:** `src/kilocode/organization/schema.ts`, `org-template/organization.jsonc`, `schema.test.ts`, README.
Add optional `budget` to the org schema: `{ run?: number, stage?: number, escalationThreshold?: number, retries?: number }` plus an optional per-stage `budget?: number` override on the pipeline `Stage`. Validation: all non-negative; `stage <= run` when both set (warn, don't hard-fail — stages sum can exceed a single stage cap); `escalationThreshold <= run`. Defaults applied in a `resolveBudget(org)` helper when the block is absent: run 50, stage 15, escalationThreshold 10, retries 2 (owner-approved). Template `organization.jsonc` gains an explicit `budget` block with those values + a comment. Tests: schema accepts/omits budget; resolveBudget fills defaults; per-stage override read; negative rejected; stage>run warns.

### W1.2 — Ceiling enforcement + escalation gate in the runner

**Files:** `runner.ts`, `state.ts` (run-level cost accessor), `runner.test.ts`.
In `advance`, after a stage completes and its cost is recorded, compute `runTotal = sum of stageCost` and `stageTotal = stageCost(stage)`:
- **Hard ceiling:** if `runTotal > budget.run` OR `stageTotal > budget.stage` (per-stage override wins), set run `halted`, `haltReason: "budget ceiling exceeded: <detail ($X/$Y)>"`, append an audit `{decision:"stop", note}` entry (reuse OrgAudit), and return `halted`-kind. This is a deterministic sibling of `org_stop`.
- **Soft escalation:** else if `runTotal >= budget.escalationThreshold` AND the NEXT stage has no `gate` already AND escalation not yet fired for this run (persist `escalated: true` on run state so it fires once), force the next stage's completion to route through a human gate (return `gate`-kind after that stage with a note "cost $X passed the $Y escalation threshold — review before continuing"). Simplest mechanism: a runtime `escalate` flag consulted where the runner decides `awaiting_approval` vs `completed`, OR inject a synthetic gate decision point. Choose the least-invasive wiring and document it.
Retries (`budget.retries`) belongs to W1.4; do NOT implement retry here — just carry the config.
Tests: run halts at run ceiling; halts at stage ceiling (with per-stage override); escalation gate fires once when threshold crossed and not already gated; escalation does NOT fire when the next stage is already a human gate; below-threshold run proceeds ungated. Use injected `costOf` returning scripted values (existing pattern).

### W1.3 — org_advance/org_status surface budget

**Files:** `tools.ts`, `tools-errors.test.ts` or a small tools-level test.
`org_status` (run_id) output gains `budget: {run, stage, escalationThreshold, retries, spent: runTotal, remaining: run-runTotal}`. `org_advance` halted-on-budget returns `action:"halted"` with the budget detail; escalation gate returns the threshold note in its `human_gate` instructions so the CEO relays "we've spent $X of $Y" to the user. CEO template (ceo.md) gate step gains one sentence: relay cumulative spend + budget at every gate. Tests: status includes budget block with correct spent/remaining; typecheck covers the tool shapes.

### W1.4 — Retry-with-escalation on failed/blocked stages

**Files:** `runner.ts`, `state.ts`, `runner.test.ts`.
Today a `failed` stage halts (W0.4). Add bounded auto-retry: when a stage would be marked `failed` (chief returned BLOCKED — currently surfaced how? verify: the runner marks failed via... CHECK — failed status is set where? if nothing sets it yet, this task WIRES the BLOCKED→failed path too, minimally), increment `attempts`; if `attempts <= budget.retries`, re-instruct the SAME stage (fresh guidance: "previous attempt was blocked: <reason>; retry") instead of halting; only halt as `failed` after retries exhausted. Escalation interplay: a retry that pushes cost past a ceiling still halts on the ceiling (W1.2 wins). Tests: BLOCKED stage retries up to `budget.retries` then fails; a retry that breaches the run ceiling halts on budget not retry-exhaustion; retries respected from config override.

### W1.5 — Cost-aware model fallback (resolveModel)

**Files:** `src/kilocode/tool/task.ts` (`resolveModel` ~line 182), test.
PREREQ CHECK (report findings before implementing): read `resolveModel` fully + how a model becomes unavailable (`ProviderModelNotFoundError` catch at ~line 164) + whether provider pricing metadata is reachable (`packages/llm` / `Provider.getModel` cost fields). Today the fallback chain is: saved → agent.model → subagent_model → parent. Extend so that when the agent's configured model is UNAVAILABLE (not merely for cost — do NOT override a working configured model), the fallback prefers the CHEAPEST capable model from the provider catalog over the blunt parent-model fallback, and the chain can exceed 2 levels. Keep it conservative: only re-rank the FALLBACK selection, never the primary choice; a healthy configured model is always honored (agents pin models deliberately). If pricing metadata is not reliably present, implement "first available from an ordered fallback list on the agent/config" instead and note the pricing gap for a later wave. Tests: configured model available → used unchanged; configured unavailable + cheaper capable present → cheaper picked; chain depth > 2 traversed; no pricing metadata → ordered-fallback path.

### W1.6 — Wave 1 exit verification

**Files:** new `wave1-exit.test.ts`; docs.
Integration exit test (runner-level, scripted costOf): a run that (a) crosses the escalation threshold → auto-gate fires with the spend note; (b) continues and breaches the run ceiling → halts with budget haltReason + audit entry; (c) a BLOCKED stage retries `budget.retries` times then fails. Assert org_status budget block (spent/remaining) throughout. Then: full targeted suites + `bun run script/test-runner.ts` (disk check first) + typecheck. Update tracked-followups (W1 closures: dossier §C core items; note W0-R2 org-tool serialization if not yet done — carry to wave close). Wave-closing final review over the whole `feat/wave-1-budget` diff, then merge to main and open `feat/wave-2-build`.
Also fold in **W0-R2** (org tool per-run serialization — the mutex closing the org_stop-overwrite race) either as its own task before W1.6 or within the exit task; the wave-close review must confirm it landed.
