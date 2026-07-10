# Wave 3 — Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Branch: `feat/wave-3-observability` (off main; Waves 0-2 merged). `bun` at `~/.bun/bin`; never stage `bun.lock`; sweeps via `bun run script/test-runner.ts`; clean `"$(getconf DARWIN_USER_TEMP_DIR)"opencode-test-*` after runs. Backend tasks are normal TDD; console (SolidJS) tasks use the preview_* tools for visual verification (no unit-testable UI).

**Goal:** Expose org-run state through a read-only HTTP API any surface can consume, plus a thin kilo-console view (run list, stage timeline, cost panel to the cent, gate-awaiting badge, polling). Operator-approved shape: **API-first + thin panel**.

**Sources:** [master plan](../specs/2026-07-10-master-plan.md) W3 · [dossier](../specs/2026-07-10-master-plan-dossier.md) §L + F2/F7 · Wave-3 grounding exploration (2026-07-10).

**Grounding (verified read-only):** org run data lives ONLY in `.kilo/org/runs/<runID>/{state.json, approvals.json}` (OrgState.Run + OrgAudit.Entry[]), NOT the session DB. kilo-console is a SolidJS dashboard (port 3017) consuming a typed SDK over HTTP + SSE. The kilocode server HttpApi lives at `src/kilocode/server/httpapi/` (groups + handlers + server.ts provide); the SDK auto-regenerates from the Effect HttpApi schema. Session cost data is in the DB; org cost is the sum of `stage.costs` per run.

**SNR scope decisions (operator-approved API-first):** Build (1) read-only org-runs HTTP route over OrgState/OrgAudit, (2) SDK client functions, (3) minimal console org-runs list + detail + cost panel + gate-awaiting badge with polling. **DEFER to Wave 4:** SSE org-event publishing (polling + session-close refresh suffices), org-runs DB table (files are fast), per-stage latency/success histograms, desktop/webhook notifications (a UI badge satisfies "a gate fires a notification"). No DB migration.

**Exit criterion (dossier):** live dashboard tracks a running org; a gate shows as a notification; the cost panel matches state.json to the cent.

**Note:** W2-R2 (extract shared xcodebuild-exec primitive) is TRACK, due before a 4th xcodebuild tool — Wave 3 adds none, so it stays deferred.

**Protocol:** per task — fresh implementer, spec review, quality review; Important findings fixed + re-reviewed. Backend: TDD (failing test first). Console: implement + preview-verify (screenshot/inspect) since there's no unit-test surface. Separate commits.

---

### W3.1 — Read-only org-runs HTTP API

**Files:** new `src/kilocode/server/httpapi/groups/org-runs.ts` (HttpApi group + schemas), new `src/kilocode/server/httpapi/handlers/org-runs.ts` (handlers reading OrgState/OrgAudit from disk), modify `src/kilocode/server/httpapi/server.ts` (register handlers in `provide`) + wherever the kilocode api group is composed into the instance HttpApi (grounding: `src/server/routes/instance/httpapi/api.ts` — VERIFY the exact composition point). Tests.
Two endpoints (read-only GET, scoped to the instance's project directory):
- `GET /org-runs` → list: `[{ runID, idea, status, createdAt, totalCost, stageCount, currentStage?, awaitingGate: boolean }]` (summary per run, cheap — read each state.json, compute totalCost via the same stageCost sum OrgRunner.status uses; reuse OrgState.list + OrgState.read + OrgRunner.status or a shared summarizer — do NOT duplicate the cost math, import it).
- `GET /org-runs/:runID` → detail: the full OrgState.Run + the parsed approvals.json audit array + a per-stage view `{stage, status, cost, attempts, startedAt, completedAt, decision?}` and the run totalCost. 404 (readable) for unknown runID; empty list when no runs dir.
Follow the Effect HttpApi pattern of a sibling group (read an existing groups/*.ts + handlers/*.ts pair fully first; mirror the schema-definition + handler-Layer + server.ts registration exactly). Error shapes match the house pattern. Tests: a tmpdir with 2 fabricated runs → list returns both with correct totalCost/awaitingGate; detail returns state + audit; unknown runID → 404; no-runs-dir → []. Test at the handler/effect level (mirror how existing httpapi handlers are tested — find one).

### W3.2 — SDK regeneration + console client functions

**Files:** regenerate SDK (`packages/sdk/js` build), `packages/kilo-console/src/client.ts` (add `loadOrgRuns(query)` + `loadOrgRunDetail(query, runID)` wrapping the new SDK methods).
Run the SDK build so the new `/org-runs` endpoints appear on the typed client (grounding: `npm run build` / `bun ./script/build.ts` in packages/sdk/js runs openapi-ts). Add the two client wrapper functions to client.ts mirroring existing `loadProjectConsole`/session loaders. Verify: the generated client exposes the org-runs methods (typecheck); the wrappers typecheck against the console's KiloClient. No new unit test needed beyond typecheck + the console view exercising them in W3.4; confirm the SDK regen didn't change unrelated generated files spuriously (commit only the org-runs additions to the .gen files if the generator is stable, else note the churn).

### W3.3 — Console org-runs list + detail views

**Files:** new `packages/kilo-console/src/routes/orgs/OrgRunsListRoute.tsx`, `OrgRunDetailRoute.tsx`; modify `src/index.tsx` (routes `/projects/:project/org-runs` + `/org-runs/:runID`), `src/shared/navigation.ts` (Path union), `src/components/app-sidebar/AppSidebar.tsx` (nav item, shown in project console).
List route: fetch `/org-runs` via the W3.2 client, render a table (runID/idea/status badge/created/totalCost/awaiting-gate indicator), click → detail. Detail route: fetch `/org-runs/:runID`, render the stage TIMELINE (pending→running→awaiting_approval→completed with per-stage status badges + timestamps) and the approvals audit trail. Match kilo-console's existing SolidJS component style (read a sibling route like the session/project console route for layout/styling conventions — reuse its components/tokens). **Verification:** use preview_start to run kilo-console, preview_navigate/preview_screenshot to confirm the list + detail render with fabricated run data (seed a `.kilo/org/runs/` in a scratch project the dev server points at, or point the console at a server instance with test runs). Report screenshots. No unit tests (UI) — preview verification is the proof.

### W3.4 — Cost panel + gate-awaiting badge + polling

**Files:** new `OrgRunCostPanel.tsx`; modify the detail route to poll + show the gate badge.
Cost panel: per-stage cost table + run total, displayed to 2 decimals; assert (in-UI + a small logic test if the sum is a pure function extractable) the displayed total equals the API's totalCost which equals the state.json sum (to the cent). Gate badge: when any stage.status === "awaiting_approval", show a prominent "AWAITING APPROVAL" badge (+ how long, from startedAt); optionally fire a browser Notification when the tab is unfocused and a gate opens (behind a feature check — OPTIONAL, don't block on it). Polling: the detail route polls `/org-runs/:runID` every 3s while the run is active; also refresh on the existing `/event` session.turn.close (reuse subscribeProjectEvents). Stop polling on completed/halted or unmount. **Verification:** preview — seed a run in awaiting_approval, confirm the badge shows and the cost panel matches the seeded state.json to the cent (preview_inspect the rendered total vs the file). Extract any pure cost-formatting/summing into a testable helper and unit-test the to-the-cent equality.

### W3.5 — Wave 3 exit verification + merge

**Files:** exit test(s); docs.
Backend exit test: the org-runs API over a fabricated multi-stage run (one stage awaiting_approval, costs set) returns list + detail with awaitingGate:true and totalCost matching the state.json sum to the cent. Console exit proof: a preview screenshot of the detail view showing the timeline + cost panel + awaiting-approval badge for that run (the "live dashboard tracks a running org; gate shows as notification; cost matches to the cent" criterion, demonstrated). Full targeted suites (org + server/httpapi + any console-adjacent) + `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'` + canonical sweep (disk check first). Update tracked-followups (Wave 3 closures; deferred: SSE org events, DB sync, latency/success panels, desktop/webhook notifications — all recorded). Wave-closing final review over the whole branch, then merge to main + open `feat/wave-4-dag`.
