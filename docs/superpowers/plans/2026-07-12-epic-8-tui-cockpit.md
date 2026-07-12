# EPIC 8 — TUI: Cockpit / Run monitoring (FINAL EPIC)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps. TDD.

**Goal:** A live TUI **Cockpit** to watch an org run: a dashboard (pipeline stage timeline + agent tree + budget gauge + activity log), a first-class gate + always-visible budget + hard stop (8.2), run modes — supervised / `--auto` headless / `--attach` watch-only + a run-list home + `--dry-run` preflight (8.3), all as a thin client over `northstar serve` (poll + state.json, attach/resume) (8.4).

**Branch:** `feat/tui-cockpit` (off main `d4a097fce6`).

**Acceptance (exit):** an org run is visible live in the Cockpit (stage statuses + budget update from the poll); closing the TUI and re-`attach`-ing shows the same run; the always-visible budget gauge reflects spent vs ceiling and the escalation threshold; a hard-stop action drives `org_stop` (via the CEO-instruction message); `--dry-run` validates an org without running it; `northstar run --auto "<idea>"` drives an org run headless.

**Architecture (from recon `wf_9a5a0b1c-50b`):** The run/stage/cost/gate/audit **data layer EXISTS** (W3 `GET /org-runs` + `/org-runs/:runID`, poll@3000ms, pure `org-runs-view.ts` helpers). Two things must-BUILD server-side: the **budget block** on the detail response, and (for the tree) the cockpit reads `organization.jsonc` client-side (thin client, like EPIC 6/7 `/file/content`). The **agent tree is Tier A** (honest, no new endpoints): CEO → per-stage chief (liveness = the stage's status) → static worker roster from the org config; worker-level liveness (Tier B) is a deferred enhancement. Hard stop reuses the CEO-instruction-message convention (7.4). `--attach`/`--auto` largely EXIST; `--dry-run` + run-list home are new. The Cockpit screen is a new route mirroring the EPIC 6 Builder route (KiloClaw pattern). SSE deferred (poll suffices — W3 precedent).

**Determinism/security invariants (PRESERVE):** the cockpit is READ-ONLY over run state + issues CEO-instruction messages for stop (never a direct `OrgRunner.stop`/`decide` from the TUI — `guardCeo`/`withRunLock`/audit/postmortem stay intact). No secrets. `config/variable.ts` untouched. The org runner + determinism pins are NOT touched.

**Conventions:** `bun` at `~/.bun/bin`. Test from `packages/opencode/`. Typecheck `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'`. NEVER stage `bun.lock`. `// kilocode_change` on shared-file edits (block form). Verify guards after each commit (annotations exit on its OWN line). Push `--no-verify`.

---

## Task 8.1 — Budget block (server) + Cockpit dashboard view-models + route

**Files:** `packages/opencode/src/kilocode/server/httpapi/groups/org-runs.ts` + `handlers/org-runs.ts` (add `budget` to the detail response — kilo files); the SDK types for the new field (hand-edit `types.gen.ts` like EPIC 6.2b — NOT a full regen); `packages/opencode/src/kilocode/cockpit/cockpit-view.ts` (NEW — pure view-models); `packages/opencode/src/kilocode/cockpit/view.tsx` (NEW — the Cockpit screen); route wiring (route.tsx variant + app.tsx Match + KiloApp hub re-export + kilo-commands `/cockpit`, mirror EPIC 6 exactly); tests.

- [ ] **RED — budget block (server) test.** `test/kilocode/server/org-runs-budget.test.ts`: extend the `GET /org-runs/:runID` detail response with `budget: { run: number; stage: number; escalationThreshold: number; retries: number; spent: number; remaining: number; escalated: boolean }` — assembled in the handler from `OrgSchema.loadOrganization(dir)` + `resolveBudget(org)` + `runSummary(run).totalCost` (spent) + `Math.max(0, budget.run - spent)` (remaining) + `run.escalated`. Mirror the `org_status` tool's assembly (`tools.ts:513-523`). Assert: a run at $12 spent with default $50 ceiling → `budget.spent===12, remaining===38, run===50, escalationThreshold===10`. Run → FAIL (field absent).
- [ ] **GREEN — server + SDK.** Add the `budget` field to the group schema + handler; hand-add the field to the SDK `OrgRunDetailResponse` type in `types.gen.ts` (mirror EPIC 6.2b's surgical hand-edit; the client `buildClientParams` for a GET response needs no whitelist change — only the response TYPE). Re-run → GREEN. Confirm `packages/sdk/openapi.json` NOT touched.
- [ ] **RED — pure view-model tests.** `test/kilocode/cockpit/cockpit-view.test.ts`. `cockpit-view.ts` exports:
  - `buildAgentTree(org: OrgSchema.Organization, detail: OrgRunDetailResponse): { ceo: string; departments: { stage: string; chief: string; status: string; workers: string[] }[] }` — CEO → per-pipeline-stage chief with the stage's live `status` + the department's static `workers[]`. Test with a fixture org (ceo + 2 departments) + a detail (one stage running, one pending) → assert the tree shape, chief liveness = stage status, workers = static roster.
  - `budgetGauge(budget): { spentFraction: number; thresholdFraction: number; overThreshold: boolean; overCeiling: boolean; escalated: boolean }` — `spentFraction = min(1, spent/run)`, `thresholdFraction = escalationThreshold/run`, `overThreshold = spent >= escalationThreshold`, `overCeiling = spent >= run`. Test the math (incl. run===0 guard → 0, no NaN).
  Run → FAIL.
- [ ] **GREEN — cockpit-view.ts** (pure; reuse `stageTimeline`/`formatCost` from a copy of `org-runs-view.ts` or import if reachable). Re-run → GREEN.
- [ ] **Route + render.** Add a `{type:"cockpit"}` route (mirror EPIC 6 6.0 exactly: route.tsx union + app.tsx Match + plugin/api.tsx exhaustiveness branch + KiloApp hub re-export + `/cockpit` command in kilo-commands). `view.tsx`: poll `sdk.client.orgRuns.detail({runID})` @ 3000ms while `run.status==="active"` (copy the W3 `OrgRunDetailRoute` poll pattern), read `organization.jsonc` once via `/file/content` for the tree structure, and render: (a) the pipeline stage timeline (`stageTimeline`), (b) the agent tree (`buildAgentTree`, Tier A), (c) the budget gauge (`budgetGauge`), (d) an activity log = the `audit` trail + stage transitions. The Cockpit takes a `runID` (from the route payload; a run-list home in 8.3 selects it). Wire `<CockpitView/>` into the Match.
- [ ] Verify (budget + cockpit-view tests green; typecheck incl. kilo-console; annotations exit 0) + commit: `feat(cockpit): budget block on org-runs detail + Cockpit route with live dashboard view-models (Tier A agent tree, budget gauge)`.

## Task 8.2 — Hard stop + always-visible budget + gate/failure notifications

**Files:** `packages/opencode/src/kilocode/cockpit/stop.ts` (NEW — `stopMessage` pure builder, like `gateMessage`); `cockpit/view.tsx` (wire the stop action + gauge + notifications); reuse `gate-card.ts`/`parseGate` + `useToast`.

- [ ] **RED — stopMessage test.** `stop.ts` exports `stopMessage(runID: string | undefined, reason: string): string` → `"stop run <runID ?? the current run>: <reason>"`. Test the string + the fallback. Run → FAIL.
- [ ] **GREEN — stop.ts** (pure). Then in `view.tsx`: a hard-stop control (a key, e.g. `S`, with a confirm) that sends `stopMessage(runID, reason)` via `sdk.client.session.prompt` to the CEO session (the same send path as the 7.4 gate card — the CEO turns it into `org_stop`; NO direct `OrgRunner.stop`). The budget gauge (from 8.1) is rendered ALWAYS-visible in the cockpit header. Surface notifications via `useToast`: on a poll transition to `awaiting_approval` → a gate toast; on `status==="halted"` → a failure/halt toast (with `haltReason`); on `escalated` flipping true → a budget toast. Reuse `parseGate`/`awaitingGateStages` for the gate surfacing.
- [ ] Verify (stopMessage test green; typecheck; annotations; manual: the gauge shows, S sends a stop message, halt toasts) + commit: `feat(cockpit): hard stop (CEO-instruction stopMessage) + always-visible budget gauge + gate/halt/budget notifications`.

## Task 8.3 — Modes: run-list home + `--dry-run` preflight + `--auto` headless + `--attach`

**Files:** `packages/opencode/src/kilocode/cockpit/run-list.ts` (NEW — pure list view-model); `cockpit/view.tsx` or a home section (run-list render); `packages/opencode/src/cli/cmd/tui/thread.ts` (+`--dry-run` flag) + `context/args.tsx` (+`dryRun`) — shared, `// kilocode_change`; a dry-run preflight surface (reuse the EPIC 6 org validation / `org_status` dry-run); confirm `--auto`/`--attach` (mostly EXISTS — verify + document); tests.

- [ ] **RED — run-list view-model test.** `run-list.ts` exports `buildRunList(summaries: OrgRunSummary[]): { runID: string; idea: string; status: string; totalCost: number; currentStage: string | null; awaitingGate: boolean; badge: string }[]` (reuse `runStatusBadge`; newest-first preserved). Test with a fixture list → assert order, badges, awaitingGate. Run → FAIL.
- [ ] **GREEN — run-list.ts** (pure). Render a run-list in the Cockpit home (from `sdk.client.orgRuns.list()`), selecting a run navigates to `{type:"cockpit", runID}`. Add a `/cockpit` (no-runID) entry that opens the run list.
- [ ] **`--dry-run` preflight.** Add a `--dry-run` flag to `TuiThreadCommand`/`Args`; when set, instead of the interactive TUI, run the org preflight (loadOrganization + validate + crossCheck — reuse the EPIC 6/`org_status` dry-run) and print the dept/stage/agent counts + issues, then exit. (A pure `dryRunReport(org, agents)` helper is testable — assert it lists issues for an invalid org, clean for a valid one.)
- [ ] **`--auto` + `--attach` (verify + document).** Confirm `northstar run --auto "<idea>"` drives an org run headless (RunCommand auto-approve + the CEO agent) — add a test or a documented smoke path; confirm `northstar attach <url>` attaches (AttachCommand EXISTS). If a thin `northstar org run` alias is cheap, add it; otherwise document that `run --auto` is the headless entry. Do NOT rebuild the headless machinery.
- [ ] Verify (run-list + dryRunReport tests green; typecheck; annotations; the flags parse) + commit: `feat(cockpit): run-list home + --dry-run preflight + --auto/--attach modes (headless + watch-only)`.

## Task 8.4 — Exit test + review-prep (FINAL)

**Files:** test `test/kilocode/cockpit/epic8-exit.test.ts`; `.changeset/epic8-tui-cockpit.md`.

- [ ] **Exit test (server + view-models end-to-end):** create a run (via `OrgState`/the runner) with a known spend + a `gate:"human"` stage; hit the real `GET /org-runs/:runID` (HTTP harness like `httpapi-org-runs.test.ts`) → assert the `budget` block math (spent/remaining/ceiling/escalated); feed the detail + a fixture org into `buildAgentTree` → assert CEO→chief→workers with the running stage's live status; `budgetGauge` → assert fractions + overThreshold; `buildRunList` on the list response → assert the run appears with the right badge/awaitingGate; `stopMessage`/`dryRunReport` → assert their outputs. Assert the cockpit path is READ-ONLY (no `OrgRunner.stop`/`decide` import in the cockpit render). Run → GREEN.
- [ ] **`.changeset/epic8-tui-cockpit.md`** (`"@ilura/northstar": minor`) — TUI Cockpit: live run dashboard (pipeline/agent-tree/budget gauge/log), hard stop, notifications, run-list home, --dry-run/--auto/--attach modes.
- [ ] Verify (exit + cockpit + org-runs suites green; typecheck; guards; changeset) + commit: `test(cockpit): EPIC 8 exit — budget block + dashboard view-models + read-only stop path`.

## Self-review
- dashboard (pipeline/tree/budget/log) → 8.1 ✓ · gate+budget+stop → 8.2 ✓ · modes+home+dry-run → 8.3 ✓ · thin-client poll/attach → 8.1/8.3 ✓ · exit → 8.4 ✓.
- **Testable cores (TDD-pinned):** the `budget` HTTP block (8.1), `buildAgentTree`/`budgetGauge` (8.1), `stopMessage` (8.2), `buildRunList`/`dryRunReport` (8.3), end-to-end (8.4). Renders (cockpit dashboard, gauge, run-list) manual-verifiable, modeled on W3 `OrgRunDetailRoute` + EPIC 6 Builder route.
- **Reuse (~85%):** W3 org-runs API + SDK + `org-runs-view.ts` helpers + poll@3000ms, EPIC 6 route/KiloClaw pattern, 7.4 gate card + CEO-message send, `org_stop`/`org_status`/`resolveBudget`, `useToast`, `/file/content` org read, AttachCommand, RunCommand `--auto`.
- **Honest scope (SNR):** agent tree = **Tier A** (chief liveness = stage status; workers = static roster) — worker-level liveness (Tier B via session-children join) DEFERRED (degrades to A on cold attach); activity log = audit trail + stage transitions (not a raw SSE event stream — SSE deferred, W3 precedent).
- **Risk:** (a) the SDK hand-edit for the `budget` response type (mirror 6.2b — response-type only, no whitelist, no full regen; verify kilo-console typecheck); (b) hard stop MUST go via the CEO message (read-only cockpit) — no direct runner mutation; (c) `--dry-run`/`--auto` reuse existing machinery, don't rebuild. Sequence 8.1 → 8.2 → 8.3 → 8.4.
- **Security:** read-only over run state; stop via CEO message (guardCeo intact); no secrets; `config/variable.ts` + runner + determinism pins untouched.
