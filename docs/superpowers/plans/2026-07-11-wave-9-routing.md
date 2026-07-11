# Wave 9 — Auto-Selection & Quality-Aware Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A task→agent routing layer that scores capability match (W8 `capabilities[]`/`preferredTypes[]`) and ranks candidates by health/perf (W8 `OrgMetrics`), surfaced as a reusable pure module + a CEO tool + informed-delegation annotations.

**Architecture:** A pure `OrgRouting` matcher/ranker (mirrors `OrgMetrics`'s pure-core style) + a thin `org_route` structured tool that assembles the roster (`Agent.Service.list()`) and per-agent health (`OrgMetrics.collect`) and calls the pure core + a light stage-prompt capability annotation. No engine changes.

**Tech Stack:** Bun, TypeScript, Effect (tools), zod (org kernel), `bun:test`.

**Scope (from the v2 Horizon backlog; user-chosen as Wave 9).** Closes: dossier §E "auto-selection input / ranking / latency-quality-aware routing" (partial — the ranking intelligence + a CEO surface).

**Deliberately deferred (documented follow-ups, NOT in W9):**
- **Chief-callable routing:** letting a department *chief* (a subagent) call `org_route` needs relaxing BOTH `guardCeo` and the `available()` `mode==="primary"` gate + `available()` loading the org to know the chiefs — moderate visibility surgery. W9 ships CEO/primary-scoped (`org_` prefix, no surgery). → **W9-R1.**
- **Per-worker health:** metrics are chief-level (worker cost folds into the chief session; `OrgMetrics.aggregate` keys on `org.departments[stage].chief`). Worker ranking is capability-only; health differentiates only chiefs. Per-worker metrics need session-tree traversal the kernel avoids. → **W9-R2.**
- **Auto-acting** (the runner auto-picking a worker / auto-replacing an unhealthy chief). W9 is advisory: it ranks/recommends; humans + the CEO agent act.

**Conventions (all tasks):** `bun` at `~/.bun/bin` (`export PATH="$HOME/.bun/bin:$PATH"`). New Kilo files start with `// kilocode_change - new file`; shared-file edits get `// kilocode_change`. NEVER stage `bun.lock`. After tests: `rm -rf "$(getconf DARWIN_USER_TEMP_DIR)"opencode-test-*`. Typecheck: `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'`. Push needs `git push --no-verify` (Turkish-locale jetbrains hook).

---

## Task W9.1 — Pure `OrgRouting` matcher + ranker

**Files:**
- Create: `packages/opencode/src/kilocode/organization/routing.ts` (namespace `OrgRouting`) — pure, no I/O/clock (model on `metrics.ts`).
- Test: `packages/opencode/test/kilocode/organization/routing.test.ts` (model on `metrics.test.ts`).

**Types:**
```ts
type TaskNeed  = { capabilities?: string[]; type?: string }
type Candidate = { agent: string; capabilities?: string[]; preferredTypes?: string[] }
type Ranked    = { agent: string; matchScore: number; health?: OrgMetrics.Health; score: number; reasons: string[] }
type RouteWeights = { match: number; health: number }   // defaults e.g. { match: 0.7, health: 0.3 }
```

- [ ] **Step 1 (RED):** `routing.test.ts` — assert `OrgRouting.capabilityScore(need, candidate)` returns a 0..1 overlap: full overlap → 1, disjoint → 0, partial → in-between, `undefined` capabilities on either side → 0 (never `NaN`), and a `need.type ∈ candidate.preferredTypes` bonus. Run → FAIL (module absent).
- [ ] **Step 2 (GREEN):** implement `capabilityScore` — set-overlap (Jaccard or need-coverage) of `need.capabilities ∩ candidate.capabilities`, plus a bounded bonus when `need.type` is in `candidate.preferredTypes`; clamp to [0,1]; `undefined`/empty → 0. Deterministic.
- [ ] **Step 3 (RED):** assert `OrgRouting.rank(need, candidates, healthByAgent, weights?)` orders best-first: a capability-matched + healthy agent outranks a mismatched or unhealthy one; **a candidate with NO health entry gets a NEUTRAL prior (treated as healthy, score≈100), NOT 0** (mirrors `OrgMetrics` `successRate` defaulting to 1 for unrun agents); stable tie-break by agent name; `reasons` explain the ranking.
- [ ] **Step 4 (GREEN):** implement `rank` — `score = weights.match*matchScore + weights.health*(health?.score ?? 100)/100`; sort desc, tie-break by name asc; populate `reasons` (e.g. "matched 2/3 capabilities", "health degraded"). `healthByAgent: Map<string, OrgMetrics.Health>`.
- [ ] **Step 5 (verify + commit):** `cd packages/opencode && bun test test/kilocode/organization/routing.test.ts` green; `bun test test/kilocode/organization/` green; typecheck clean. Gotchas: undefined caps → 0 not NaN; missing health → neutral prior; deterministic order. `feat(routing): pure OrgRouting capability matcher + health-aware ranker`

---

## Task W9.2 — `org_route` structured tool (CEO/primary-scoped) + registry dance

**Files:**
- Create: `packages/opencode/src/kilocode/tool/org-route.ts` (id `org_route`) + `org-route.txt` (description).
- Modify: `packages/opencode/src/kilocode/tool/registry.ts` — the 4 registration sites (below).
- Modify (fixtures — the error-prone part): `packages/opencode/test/kilocode/tool-registry-indexing.test.ts` + `packages/opencode/test/kilocode/tool-registry-indexing-import-failure.test.ts`.
- Test: `packages/opencode/test/kilocode/tool/org-route.test.ts`.

**Tool behavior:** params `{ stage?: string; capabilities?: string[]; type?: string }`. Load org (`load(dir)` from `tools.ts`), roster (`(yield* Agent.Service).list()` — carries merged `capabilities`/`preferredTypes`), health (`await OrgMetrics.collect(dir)` → `Map<agent, OrgMetrics.health(m)>`). Candidates = if `stage` given → `org.departments[stage].workers`; else → the department chiefs (`Object.values(org.departments).map(d => d.chief)`, deduped). Build `Candidate[]` by looking up each name's Info; call `OrgRouting.rank(need, candidates, healthByAgent)`; return the ranked list as `output` + `metadata`. **CEO/primary-scoped** via the `org_` id prefix + `guardCeo(org, ctx.agent)` (mirror `org_status` in `tools.ts` — reuse `load`/`guardCeo`/`result` exports). No `ctx.ask` (so NO `config/permission.ts` key needed).

- [ ] **Step 1 (RED):** `org-route.test.ts` — seed a tmpdir org (`.kilo/organization.jsonc`) + tagged agents + ≥2 runs (varied `stage.costs`/outcomes for health), invoke `RouteTaskTool.execute` as the CEO with a `{capabilities}` need, assert the capability-matched + healthy candidate ranks first and a mismatched/unhealthy one lower; assert `guardCeo` rejects a non-CEO caller. Run → FAIL (tool absent).
- [ ] **Step 2 (GREEN — tool):** `org-route.ts` per the behavior above; `org-route.txt` description.
- [ ] **Step 3 (GREEN — registry.ts, 4 sites):** (a) import + `const routeTask = yield* RouteTaskTool` in `infos()`; add `routeTask` to BOTH return objects in `infos()` (the `if(!notebook)` early return AND the full return). (b) `build()` — add `routeTask: Tool.Info` to the param type + `routeTask: Tool.init(tools.routeTask)` in the `Effect.all`. (c) `extra()` — add `routeTask: Tool.Def` to the param type + `tools.routeTask` to the returned array (near the org block). Since the id starts with `org_`, `available()` (primary-only) + `applyVisibility` (org-config-gated) apply for free.
- [ ] **Step 4 (GREEN — fixtures):** update `tool-registry-indexing.test.ts`: the `orgIDs` visibility array (~L325) if `org_route` is CEO/primary-visible; the `extra()` `tools` fixture literal (~L402-435, add `routeTask: def("route_route")`… use the real id `"org_route"`); the `orgIDs` extra list (~L436-445); and **EVERY** `.toEqual([...])` in "conditionally includes Kilo registry extras" (~L449-652, 8 client-variant assertions) must include `"org_route"`. And `tool-registry-indexing-import-failure.test.ts` `infos()` fixture (~L37-68, add `routeTask: info("org_route")`). **Miss one array and the suite fails — grep for the tool-id lists and update all.**
- [ ] **Step 5 (verify + commit):** `cd packages/opencode && bun test test/kilocode/tool/org-route.test.ts test/kilocode/tool-registry-indexing.test.ts test/kilocode/tool-registry-indexing-import-failure.test.ts` green; `bun test test/kilocode/` (broad, to catch any missed registry fixture) green; typecheck clean. `feat(routing): org_route tool — rank candidate agents by capability + health (CEO-scoped)`

---

## Task W9.3 — Stage-prompt worker capability annotation

**Files:**
- Modify: `packages/opencode/src/kilocode/organization/prompts.ts` (`StageInput`, `stagePrompt` — the `workers.join(", ")` seam ~L39-43).
- Modify: `packages/opencode/src/kilocode/organization/runner.ts` (`stagePromptFor` ~L174 — pass each worker's capabilities).
- Test: `packages/opencode/test/kilocode/organization/prompts.test.ts` (+ a runner assertion if needed).

**Behavior:** annotate each worker in the stage prompt with its `capabilities` (informed delegation), e.g. `- swiftui-dev-1 (swiftui, ui-implementation)`. Do NOT reorder (no per-stage capability need is declared; reordering is deferred to the `org_route` tool with an explicit need). Back-compat: workers with no capabilities render plain (as today).

- [ ] **Step 1 (RED):** `prompts.test.ts` — extend `StageInput` to carry worker capabilities (e.g. `workers: Array<{ name: string; capabilities?: string[] }>` OR a parallel `workerCapabilities?: Record<string,string[]>`); assert `stagePrompt` renders a tagged worker as `name (cap1, cap2)` and an untagged worker as just `name`. Run → FAIL.
- [ ] **Step 2 (GREEN):** update `StageInput` + `stagePrompt` rendering; update `stagePromptFor` (runner.ts) to source each worker's capabilities from the loaded roster (`ConfigAgent.load`/`Agent` info — reuse whatever the runner already has, or load once). Keep it back-compat (untagged → plain).
- [ ] **Step 3 (verify + commit):** `cd packages/opencode && bun test test/kilocode/organization/prompts.test.ts test/kilocode/organization/runner.test.ts` green; `bun test test/kilocode/organization/` green; typecheck clean. `feat(routing): annotate stage-prompt workers with their capabilities for informed delegation`

---

## Task W9.4 — Wave 9 exit test + full verification

**Files:**
- Create: `packages/opencode/test/kilocode/organization/wave9-exit.test.ts`.

- [ ] **Step 1 (exit — ranking intelligence):** a pure `OrgRouting.rank` scenario proving auto-selection: candidate A (capability-matched + healthy), candidate B (mismatched), candidate C (matched but unhealthy) → order is A, then C or B per the weights; assert A is first and the reasons explain why. Load-bearing: a broken matcher or a 0-instead-of-neutral missing-health default would reorder these.
- [ ] **Step 2 (exit — end-to-end tool):** seed a tmpdir org + tagged agents + runs with varied health, invoke `org_route` as the CEO for a real `{capabilities}` need, assert the top-ranked agent is the capability-matched healthy one (to-the-name), and `guardCeo` rejects a non-CEO caller.
- [ ] **Step 3 (exit — delegation surface):** assert the stage prompt lists a tagged worker with its capabilities.
- [ ] **Step 4 (full sweep):** `cd packages/opencode && bun run script/test-runner.ts` → all green (canary: no `Cannot access before init`/TDZ — `routing.ts`/`org-route.ts` must not create a registry module-init cycle; if the tool statically imports a heavy module, use the W6 dynamic-import fix). Clean temp. Typecheck clean.
- [ ] **Step 5 (commit):** `test(routing): wave 9 exit — capability+health ranking, org_route end-to-end, worker capability annotation`

---

## Self-review (plan vs. goal)

- **Capability matching** → W9.1 `capabilityScore` ✓ · **health/perf ranking** → W9.1 `rank` + W8 `OrgMetrics` ✓ · **routing surface** → W9.2 `org_route` tool ✓ · **informed delegation** → W9.3 annotation ✓ · **exit (auto-selects matched+healthy over mismatched/unhealthy)** → W9.4 ✓.
- **Deferred w/ reasons:** chief-callable routing (W9-R1, visibility surgery), per-worker health (W9-R2, kernel granularity), auto-acting (advisory only). Recorded in tracked-followups at wave close.
- **Sequencing:** W9.1 (pure) → W9.2 (tool, consumes W9.1 + registry dance) → W9.3 (prompt annotation, independent) → W9.4 (exit, all). Execute in order (subagent-driven = one implementer at a time). The registry dance in W9.2 (8 `.toEqual` arrays + 2 fixtures) is the highest-risk step — verify with a broad `bun test test/kilocode/` before commit.
