# Wave 8 — Registry & Routing v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an agent registry layer to the Ilura org kernel — capability tagging, per-agent metrics + health scoring, a console scoreboard, artifact version rollback + impact graph, and a fixture-org benchmark harness.

**Architecture:** Pure state-only modules over the existing `.kilo/org/runs/<runID>/state.json` file tree + org chart, plus a W3-pattern read-only HTTP endpoint + kilo-console view, plus runner lifecycle hooks for deliverable snapshots. No new engine; reuse `OrgRunner`/`OrgState`/`OrgArtifacts`/`OrgSchema` unchanged where possible.

**Tech Stack:** Bun, TypeScript, zod (org kernel), Effect Schema (HTTP wire), @hey-api/openapi-ts (SDK codegen), Solid.js (kilo-console), `bun:test`.

**Dossier scope:** §2 core (capability tagging), §1 (health), §29 partial (benchmark), §9 remainder (artifact rollback + graph). Hybrid search is explicitly *"if not done in W6"* → SNR-deferred, OUT of W8.

**Exit criterion:** agent scoreboard renders in console (HTTP endpoint + browser proof); rollback restores a prior deliverable AND reports the invalidated downstream stages.

**Conventions (all tasks):** `bun` at `~/.bun/bin` (`export PATH="$HOME/.bun/bin:$PATH"`). New Kilo files start with `// kilocode_change - new file`; edits to shared files get a `// kilocode_change` marker. NEVER stage `bun.lock`. After tests: `rm -rf "$(getconf DARWIN_USER_TEMP_DIR)"opencode-test-*`. Per-task typecheck: `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'` (the jetbrains package fails under the Turkish locale — unrelated). Org-kernel tests: `cd packages/opencode && bun test test/kilocode/organization/`. Push requires `git push --no-verify` (same locale hook).

---

## Task W8.1 — Capability tagging (`capabilities[]` / `preferredTypes[]` on agents)

**Files:**
- Modify: `packages/opencode/src/config/agent.ts` (AgentSchema ~L30-81; KNOWN_KEYS ~L83-104)
- Modify: `packages/opencode/src/agent/agent.ts` (runtime `Info` Schema.Struct ~L35-64; config→runtime copy loop ~L318-354, after the `subordinates` line ~L349)
- Modify: 2-3 `org-template/agents/*.md` (add frontmatter) — e.g. a SwiftUI specialist + a validator
- Test: `packages/opencode/test/kilocode/organization/template.test.ts` (mirror the "every agent pins a model" loop ~L113-118)

**Naming:** use **`capabilities`** and **`preferredTypes`**. Do NOT use `skills` — `agent/agent.ts` L22/L512/524 already uses `skills` for the prompt-Skill service (different concept; collision risk).

- [ ] **Step 1 (RED):** In `template.test.ts`, add frontmatter `capabilities: [...]` / `preferredTypes: [...]` to a chosen agent's `.md`, then add a test asserting that after `ConfigAgent.load(TEMPLATE)` that agent's loaded `Info` exposes both as string arrays. Run → FAIL (fields dropped).
- [ ] **Step 2 (GREEN — parse layer):** In `config/agent.ts`, add `capabilities` + `preferredTypes` to `AgentSchema` mirroring `subordinates` (L75-77: `Schema.optional(Schema.mutable(Schema.Array(Schema.String)))`), AND add both strings to `KNOWN_KEYS` (L83-104). **CRITICAL:** without the KNOWN_KEYS entry, `normalize()` L114-116 dumps them into `options` → forwarded to the provider as request params. NO `normalize()` expansion (they are pure metadata, unlike `subordinates` which expands to permission.task rules — do NOT copy that block).
- [ ] **Step 3 (GREEN — runtime layer):** In `agent/agent.ts`, add both fields to the runtime `Info` Schema.Struct (mirror `subordinates` L61), and add two lines to the copy loop after L349: `item.capabilities = value.capabilities ?? item.capabilities` and `item.preferredTypes = value.preferredTypes ?? item.preferredTypes`.
- [ ] **Step 4:** Add `capabilities`/`preferredTypes` frontmatter to 2-3 real template agents (YAML inline array, same syntax as `subordinates`). Keep the 63-agent count in `template.test.ts` (L68/L293-296) unchanged.
- [ ] **Step 5 (verify):** `cd packages/opencode && bun test test/kilocode/organization/template.test.ts` green; `bun test test/config/ test/agent/` (or the agent-config suites) green; typecheck clean. OrgSchema (`schema.ts`) stays UNTOUCHED — no matcher consumes capabilities yet (greenfield; deferred).
- [ ] **Step 6 (commit):** `feat(registry): capability tagging (capabilities[]/preferredTypes[]) on agents`

---

## Task W8.2 — Per-agent metrics + health scoring (pure)

**Files:**
- Create: `packages/opencode/src/kilocode/organization/metrics.ts` (namespace `OrgMetrics`) — model on `postmortem.ts` (pure/deterministic, no clock/no I/O)
- Test: `packages/opencode/test/kilocode/organization/metrics.test.ts` (copy `postmortem.test.ts` `completedRun()` factory idiom)

**Data source facts:** `state.json` records NO agent name — only `taskID`. Attribute a stage to an agent by joining `stage → org.departments[stage].chief` (`schema.ts` L41-49). Cost via **exported** `OrgState.stageCost(stage)` (state.ts:70 — never re-sum). Latency = `Date.parse(completedAt) - Date.parse(startedAt)` (both optional ISO; `null` when either missing). Granularity is **chief-level** (worker cost is folded into the chief session via `KiloCostPropagation.childCost` recursion).

- [ ] **Step 1 (RED):** `metrics.test.ts` — fabricate `OrgState.Run[]` + an `OrgSchema.Organization`; assert `OrgMetrics.aggregate(org, runs)` returns one row per chief with summed cost, run/stage counts, successRate, avg latency.
- [ ] **Step 2 (GREEN):** Implement `aggregate(org, runs): AgentMetrics[]` where `AgentMetrics = { agent: string; runs: number; stages: number; totalCost: number; avgCostPerStage: number; completed: number; failed: number; blocked: number; successRate: number; avgLatencyMs: number | null }`. Iterate each run's stages, map `stage → org.departments[stage].chief`, bucket by chief, use `OrgState.stageCost`, compute latency. `successRate = completed/(completed+failed)` (guard divide-by-zero → 1 or 0 documented). **Skip stages whose department is absent** (historical org drift — tolerate).
- [ ] **Step 3 (RED):** `health.test.ts` (or in metrics.test.ts) — table-driven thresholds → band/score/reasons, incl. boundaries (errorRate exactly at ceiling, null latency).
- [ ] **Step 4 (GREEN):** Implement `health(m: AgentMetrics, thresholds?: HealthThresholds): { score: number; band: 'healthy'|'degraded'|'unhealthy'; reasons: string[] }` — pure, threshold-driven (penalize `errorRate = failed/stages` over a ceiling and `avgLatencyMs` over a ceiling). `const DEFAULTS` object like `schema.ts` BUDGET_DEFAULTS. No clock/no I/O.
- [ ] **Step 5 (GREEN — collector):** Add a thin async `collect(projectDir): Promise<AgentMetrics[]>` = `OrgState.list` → `OrgState.read` (per-run try/catch skip-on-corrupt, exactly like `OrgRunsView.list`) + `OrgSchema.loadOrganization` (tolerate absence) → `aggregate`. Test with a tmpdir writing several runs incl. one corrupt `state.json`.
- [ ] **Step 6 (verify + commit):** org tests green; typecheck clean. Gotchas to honor: cost `0`/absent = "unknown" not "free"; revised-stage latency = last iteration only (document); use exported `stageCost` not the private runner dup. `feat(registry): per-agent metrics aggregation + health scoring (pure OrgMetrics)`

---

## Task W8.3 — Agent metrics HTTP endpoint + SDK regen

**Files (mirror W3 org-runs exactly):**
- Create: `packages/opencode/src/kilocode/server/httpapi/groups/agents.ts` (`AgentsApi`, mirror `groups/org-runs.ts` L84-128)
- Create: `packages/opencode/src/kilocode/server/httpapi/handlers/agents.ts` (`AgentsView.list` + `agentsHandlers`, mirror `handlers/org-runs.ts` L17-105)
- Modify: `packages/opencode/src/server/routes/instance/httpapi/api.ts` (import + `.addHttpApi(AgentsApi)` in the kilocode_change block ~L36/L86)
- Modify: `packages/opencode/src/kilocode/server/httpapi/server.ts` (import + `agentsHandlers` in `provide([...])` ~L24/L46)
- Test: `packages/opencode/test/kilocode/server/httpapi-agents.test.ts` (copy the `app()` harness from `httpapi-org-runs.test.ts`)
- Regen: `packages/sdk/js` → `bun run build`

- [ ] **Step 1 (RED):** `httpapi-agents.test.ts` — `app()` harness (`HttpRouter.toWebHandler(HttpApiServer.routes...)`, `x-kilo-directory` header). Seed 2 runs via `OrgState.create/update` with varied `stage.costs`. Assert `GET /agents` returns per-chief rows (cost summed, run/stage counts) to-the-cent (`Math.round(x*100)`).
- [ ] **Step 2 (GREEN):** `groups/agents.ts` — `AgentsApi = HttpApi.make("agents").add(HttpApiGroup.make("agents").add(HttpApiEndpoint.get("list","/agents",{query:WorkspaceRoutingQuery, success:described(AgentMetricsResponse,...)}).annotateMerge(OpenApi.annotations({identifier:"agents.list",...}))).middleware(InstanceContextMiddleware).middleware(WorkspaceRoutingMiddleware).middleware(Authorization))`. Define `AgentMetricsResponse` as **Effect Schema** view-structs (decoupled from zod — do NOT export zod types over HTTP). The `identifier` `"agents.list"` becomes `client.agents.list`.
- [ ] **Step 3 (GREEN):** `handlers/agents.ts` — `AgentsView.list(projectDir)` calls `OrgMetrics.collect` (W8.2), maps to the wire struct; `agentsHandlers = HttpApiBuilder.group(InstanceHttpApi, "agents", ...)` using `InstanceState.context.directory`. Keep the die-on-corrupt discipline (don't leak `tmp.path`/`state.json` in errors).
- [ ] **Step 4 (GREEN — wiring):** Register in `api.ts` (`.addHttpApi(AgentsApi)`) and `server.ts` (`provide([...agentsHandlers])`).
- [ ] **Step 5 (SDK regen):** `cd packages/sdk/js && bun run build` → `client.agents.list()` + `AgentMetricsResponse` type appear in `src/v2/gen/`. Do NOT hand-edit `sdk.gen.ts`.
- [ ] **Step 6 (verify + commit):** endpoint tests green (200 + corrupt-run-skipped + no path leak); typecheck. `feat(registry): read-only /agents metrics endpoint + SDK regen`

---

## Task W8.4 — Console agent scoreboard

**Files (mirror W3 kilo-console):**
- Modify: `packages/kilo-console/src/client.ts` (add `loadAgentMetrics(input)` mirroring `loadOrgRuns` L432; re-export the new SDK type ~L100)
- Create: `packages/kilo-console/src/routes/orgs/agents-view.ts` (pure helpers: sort/format/band-badge; import only the SDK type; clamp non-finite via `number()`)
- Create: `packages/kilo-console/src/routes/orgs/agents-view.test.ts` (`bun:test`, in-file factory — mirror `org-runs-view.test.ts`)
- Create: `packages/kilo-console/src/routes/orgs/AgentScoreboardRoute.tsx` (mirror `OrgRunsListRoute.tsx`: `createResource(query, loadAgentMetrics)` + `role="table"` markup + reuse the discovery/recovery block)
- Modify: `packages/kilo-console/src/index.tsx` (add `<Route path="/projects/:project/agents" component={AgentScoreboardRoute} />` ~L29)

- [ ] **Step 1 (RED):** `agents-view.test.ts` — in-file `metrics()` factory; test pure helpers (cost format, health-band badge variant, sort-by-cost/health, non-finite normalization, undefined-input guard).
- [ ] **Step 2 (GREEN):** `agents-view.ts` pure helpers importing only the SDK `AgentMetricsResponse` type. Local `number()` clamps `NaN/Infinity → 0`.
- [ ] **Step 3 (GREEN):** `loadAgentMetrics` in `client.ts` (`demand("Agent metrics", await client(input).agents.list(directory(input)))`).
- [ ] **Step 4 (GREEN):** `AgentScoreboardRoute.tsx` — copy `OrgRunsListRoute.tsx` structure incl. the exact base/discoverable/attemptedRecovery recovery block (or the route strands on loading). `role="table"` scoreboard. Register the route in `index.tsx`.
- [ ] **Step 5 (verify):** `cd packages/kilo-console && bun test src` green; typecheck. **Browser proof:** start the console dev server + a seeded run, navigate to `/projects/:project/agents`, screenshot the rendered scoreboard, confirm 0 console errors (there is NO e2e harness — this is the render proof).
- [ ] **Step 6 (commit):** `feat(registry): kilo-console agent scoreboard view`

---

## Task W8.5 — Artifact version snapshot + rollback (`OrgVersions`)

**Files:**
- Create: `packages/opencode/src/kilocode/organization/versions.ts` (namespace `OrgVersions`)
- Modify: `packages/opencode/src/kilocode/organization/runner.ts` (snapshot hooks at `decide()` ~L723 and `settleRunningStage` on-completion ~L438)
- Test: `packages/opencode/test/kilocode/organization/versions.test.ts` (alongside `artifacts.test.ts`)

**Critical fact:** `reviseBaseline` is a **SHA-256 string, not content** — NO prior deliverable content is retained anywhere today (the chief overwrites the `.md` in place). Rollback CANNOT be built on the baseline alone; it needs new content-snapshot storage. Real deliverable path: `.kilo/org/runs/<runID>/deliverables/<stage>.md` (note the `runs/` segment).

- [ ] **Step 1 (RED):** `versions.test.ts` — assert `OrgVersions.snapshot(projectDir, runID, stage)` writes the current deliverable content to `.kilo/org/runs/<runID>/deliverables.versions/<stage>/<sha256>.md` + a manifest entry `{ts, stage, hash, path}`; idempotent on identical hash (de-dup like `rag.ts:150`).
- [ ] **Step 2 (GREEN):** Implement `snapshot` / `list(runID, stage): VersionEntry[]` (ordered) / `diff(runID, stage, hashA, hashB)` (use the npm **`diff`** package `createTwoFilesPatch`/`structuredPatch` — already a dep; NOT `DiffFull`, which is git-ref-only) / `rollback(runID, stage, hash)` (copies a stored version back onto `deliverablePath` AND snapshots what it replaced first — **never destructive**). Reuse `runner.deliverableHash` for hashing. Obey the single-writer discipline (CEO-serial; key everything by `(runID, stage)`).
- [ ] **Step 3 (GREEN — runner hooks):** In `runner.ts` `decide()` (~L723, where the revise baseline hash is taken) snapshot the pre-revise content; in `settleRunningStage` (~L438, where `reviseBaseline` is consumed on completion) snapshot the newly-accepted content. Both are best-effort (a snapshot failure must NOT break the run — wrap like the postmortem hook).
- [ ] **Step 4 (verify + commit):** `versions.test.ts` + full `test/kilocode/organization/` green; typecheck. Prove rollback restores exact prior bytes and is non-destructive. `feat(registry): deliverable version snapshot + non-destructive rollback (OrgVersions)`

---

## Task W8.6 — Artifact graph + impact radius (`OrgGraph`)

**Files:**
- Create: `packages/opencode/src/kilocode/organization/graph.ts` (namespace `OrgGraph`)
- Modify: `packages/opencode/src/kilocode/organization/runner.ts` (surface impact radius on a `revise` decision)
- Test: `packages/opencode/test/kilocode/organization/graph.test.ts` (pure, model on `schema.test.ts`)

**Substrate:** declared edges are free via `OrgSchema.resolveRequires(org)` (forward edges). Impact radius = the inverse closure.

- [ ] **Step 1 (RED):** `graph.test.ts` — pure fixtures over `OrgSchema.Organization`. Assert `OrgGraph.dependents(org)` = inverse of `resolveRequires` (reverse index), and `OrgGraph.impactRadius(org, stage)` = transitive dependents closure (all stages that (in)directly `require` `stage`).
- [ ] **Step 2 (GREEN):** Implement `dependents(org): Record<string,string[]>` and `impactRadius(org, stage): string[]` as pure functions (invert `resolveRequires`; transitive back-walk like `isAncestor`/`findCycle` in schema.ts). No I/O.
- [ ] **Step 3 (GREEN — wire the exit behavior):** In `runner.ts` `decide()` on a `revise` (and on a rollback path), compute `impactRadius(org, stage)` and attach the invalidated downstream stage list to the returned run/decision surface (e.g. a `revised`/`invalidatedDownstream` field or the escalation/decision note) so a rollback "invalidates downstream artifacts" is observable. Keep it additive/back-compat.
- [ ] **Step 4 (verify + commit):** `graph.test.ts` + org tests green; typecheck. `feat(registry): artifact dependency graph + impact radius on revise/rollback (OrgGraph)`

---

## Task W8.7 — Benchmark harness (`benchmark.jsonc`)

**Files:**
- Create: `packages/opencode/src/kilocode/organization/benchmark.ts` (namespace `BenchmarkSchema` + runner) — **zod + jsonc-parser** (mirror `schema.ts`), NOT Effect Schema
- Test: `packages/opencode/test/kilocode/organization/benchmark.test.ts`

**Key fact:** `OrgRunner` is already deterministic + LLM-free (LLM lives only in `tools.ts`). The harness ~90% drives `OrgRunner.advance` with a scripted `costOf` + writes ≥50-char deliverables. The org kernel emits ZERO Bus events — a metric emit must inject its sink (default no-op; Bus-backed at the CLI boundary, like `asc/review-monitor.ts`'s injected `publish`).

- [ ] **Step 1 (RED — schema):** `benchmark.test.ts` asserting `BenchmarkSchema.validate()` (pure, returns `string[]`, non-throwing) catches malformed SLA / unknown-stage refs, mirroring `schema.test.ts`. Struct: `{ org: Organization | orgPath: string; idea; mode?; costs: Record<taskID,number>; clock?: number|number[]; sla: { maxCost?; maxStages?; expectStatus?: 'completed'|'halted'; maxRetries?; deliverables?: string[] } }`. `parse()`/`validate()`/`loadBenchmark(path)` (read→parseJsonc→parse→validate→throw).
- [ ] **Step 2 (GREEN — fixture runner):** `runBenchmark(projectDir, bench): Promise<Metrics>` — builds `Deps` from the scripted table (`costOf = async(id)=>bench.costs[id]`, `now` = scripted clock); `OrgRunner.start` then loops `OrgRunner.advance`, writing a ≥50-char deliverable per `InstructItem` via `OrgArtifacts.deliverablePath`, auto-answering gates via `OrgRunner.decide` per a scripted decision map, terminating on `done`/`halted`. **`costOf` semantics: cumulative-per-taskID, not per-call delta** (see runner.test.ts "cost accumulates").
- [ ] **Step 3 (GREEN — SLA eval):** `evaluateSla(metrics, bench.sla): string[]` (non-throwing violation list) over `OrgRunner.status()`/`OrgState.runSummary()`. Note budget ceiling is enforced POST-stage → recorded total can exceed cap by one stage's spend; assert on final state.
- [ ] **Step 4 (GREEN — metric emit):** thin `emit` via an INJECTED sink (default no-op; fake sink captures in tests). Bus wiring deferred to the CLI boundary.
- [ ] **Step 5 (verify + commit):** `benchmark.test.ts` green (a passing fixture + one violating each SLA field); typecheck. `feat(registry): fixture-org benchmark harness + SLA regression eval (benchmark.jsonc)`

---

## Task W8.8 — Wave 8 exit test + full verification

**Files:**
- Create: `packages/opencode/test/kilocode/organization/wave8-exit.test.ts` (+ optionally a server-side `wave8-exit` for the /agents surface, copy `wave3-exit.test.ts`)

- [ ] **Step 1 (exit test — scoreboard):** Seed runs via `OrgState.create/update` with varied `stage.costs`, drive the real `/agents` endpoint via the `app()` harness, assert the scoreboard payload (per-chief rows, to-the-cent totals, health bands).
- [ ] **Step 2 (exit test — rollback + invalidation):** Build a multi-stage fixture where stage B `requires` stage A. Snapshot A (v1), overwrite A (v2), then `OrgVersions.rollback(A, v1)` → assert A's file bytes == v1, AND `OrgGraph.impactRadius(org, A)` includes B (downstream invalidated). This is the literal exit criterion.
- [ ] **Step 3 (browser proof):** Console scoreboard renders at `/projects/:project/agents` (screenshot, 0 console errors) — from W8.4.
- [ ] **Step 4 (full sweep):** `cd packages/opencode && bun run script/test-runner.ts` → expect all green (watch the canary: no `Cannot access before init` / TDZ). Clean temp. Typecheck clean (jetbrains excluded).
- [ ] **Step 5 (commit):** `test(registry): wave 8 exit — agent scoreboard + version rollback with downstream invalidation`

---

## Self-review (plan vs. dossier)

- **§2 capability tagging** → W8.1 ✓ · **§1 health** → W8.2 ✓ · **§29 benchmark** → W8.7 ✓ · **§9 artifact rollback + graph** → W8.5 + W8.6 ✓ · **exit (scoreboard + rollback-invalidates-downstream)** → W8.3/W8.4 + W8.5/W8.6 + W8.8 ✓.
- **Deferred (explicit):** hybrid search (SNR, was already v2-deferred in W6); task→agent auto-selection/routing (greenfield, no consumer — Horizon backlog); worker-level cost (no backing data — chief-level only); content cross-ref parsing for the graph (optional stretch, not exit-critical).
- **Sequencing/deps:** W8.1 independent · W8.2→W8.3→W8.4 (metrics→endpoint→console) · W8.5→W8.6 (rollback + graph, wired for exit) · W8.7 independent · W8.8 depends on all. Execute in numeric order (subagent-driven = one implementer at a time).
