# Master-Plan Dossier — Northstar Autonomous Apple Software Company

**Date:** 2026-07-10
**Repo:** /Users/mertcanbasak/Now/northstar — branch `feat/agent-organization`
**Baseline:** 26-agent organization core (v1) delivered per `docs/superpowers/specs/2026-07-09-agent-organization-core-design.md`. 10 cluster-clarification reports synthesized here covering gap sections §1–§30.
**Owner constraint:** SNR ≥ 85% — every wave ships working, testable software; low-signal items are cut explicitly (§4 of this dossier).

**Anchor files (recurring across the plan):**
- Org kernel: `packages/opencode/src/kilocode/organization/{schema,state,runner,tools,artifacts,depth,prompts}.ts`
- Cost: `packages/opencode/src/kilocode/session/cost-propagation.ts`, `packages/core/src/kilocode/cost/max-cost-nudge.ts`
- Agents/permissions: `packages/opencode/src/config/agent.ts`, `packages/opencode/src/agent/subagent-permissions.ts`, `packages/opencode/src/permission/{index,arity}.ts`
- Delegation: `packages/opencode/src/kilocode/tool/task.ts`, `organization/depth.ts`
- Substrates: `packages/kilo-indexing/`, `packages/kilo-memory/`, `packages/kilo-console/`, `packages/kilo-telemetry/`, `packages/kilo-gateway/`, `packages/kilo-sandbox/`, `packages/opencode/src/plugin/index.ts`, `packages/opencode/src/background/job.ts`, `packages/opencode/src/bus/`
- Org config: `org-template/organization.jsonc`, `org-template/agents/*.md` (26 files)
- Release scripts: `script/{version,changelog,raw-changelog,publish-start,sync-versions}.ts`, `packages/opencode/script/publish.ts`
- Run state: `.kilo/org/runs/<runID>/{state.json,deliverables/*.md}`

---

## 1. CAPABILITY MAP

Duplicates merged: one row per underlying capability, all satisfied gap sections listed. Class: EXISTS / PARTIAL / MISSING / EXTERNAL / QUESTIONABLE (= cut candidate, see §4). Size: S ≈ ≤2d, M ≈ 3–5d, L ≈ 1–2w, XL ≈ >2w.

### A. Kernel & substrates (EXISTS — the v1 baseline)

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Org pipeline kernel: schema+validation, deterministic runner, human gates, depth ≤ 2, permission ceiling, artifact validation, resume | §1 §5 §22 §23 §30 | EXISTS | — | — | Foundation for everything below |
| Cost propagation child→parent (per-message, per-stage) | §4 §24 §30 | EXISTS | — | session DB | Substrate for all budget/metrics work |
| Dynamic agent registry (`.kilo/agents/*.md`, no rebuild) | §2 | EXISTS | — | config loader | Add agents by dropping markdown |
| RAG substrate: embedders (10+), LanceDB/Qdrant, `semantic_search` tool, file watcher, incremental re-index | §8 | EXISTS | — | embedder key (BYOK) | RAG needs config, not new infra |
| Session memory: `kilo_memory_save`/`kilo_memory_recall` | §6 §25 §27 | EXISTS | — | — | Base to extend org-wide |
| kilo-console + kilo-telemetry + Bus event system | §24 §22 | EXISTS | — | — | Dashboard + notification substrate |
| kilo-gateway multi-provider routing (BYOK + managed) | §3 | EXISTS | — | provider keys | Model routing substrate |
| Sandbox exec isolation (seatbelt/bubblewrap) | §10 §15 | EXISTS | — | — | Safe agent builds/tests |
| Plugin hook system (`plugin/index.ts` Hooks) | §28 | EXISTS | — | — | Extensibility point |
| Unit + UI testing agents (XCTest/XCUITest via bash allowlists) | §13 | EXISTS | — | — | Testing stage is live |
| Marketing agents: aso-specialist, pricing-analyst, copywriter, marketing-chief, preview-designer | §18 | EXISTS | — | websearch/webfetch | Full listing package generation |
| `generate_image` tool (text→image, image-edit; icons/screenshots/marketing) | §17 | EXISTS | — | EXTERNAL image-model API | All v1 visual assets |
| Git/version/changelog/GitHub-release/archive scripts | §20 | EXISTS | — | gh token | Release plumbing done |
| Human review requests + approval workflow (gates, `org_decision`, question tool) | §22 | EXISTS | — | — | Core control surface |
| RBAC-lite: permission rulesets + min-inheritance across depth | §23 | PARTIAL (sufficient v1) | — | — | Worker containment |
| Session fork/resume + background jobs | §5 §30 | EXISTS | — | — | Pipeline resume, parallel groundwork |
| Apple docs access via apple-docs agent (webfetch to developer.apple.com; covers HIG, frameworks, review guidelines) | §7 | EXTERNAL+PARTIAL | S | network | Live but unindexed; sufficient v1 |

### B. Hardening & config wins

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Tracked follow-ups: 5 real bugs (A→B→A cost double-count; org tools visible to all agents not just CEO; depth check after `ctx.ask`; +2) + 5 polish items — `docs/.../tracked-followups.md` | all | PARTIAL (bugs) | S–M | — | Reliability baseline; blocks trust in every metric built later |
| Audit trail export: `.kilo/org/runs/<id>/approvals.json` + read-only `audit_log` tool (data already in state.json + session DB) | §9 §22 §27 §23 | PARTIAL | S | state.json reader | Compliance, debugging, learning input |
| Emergency stop: org-level kill (abort all subagent sessions, mark run failed) | §4 | PARTIAL | S | AbortSignal (exists) | One-button spend safety valve |
| Prompt-injection sanitizer: fence idea text + prior deliverables + user decisions before injection into CEO/chief prompts | §30 §15 | MISSING | M | `organization/prompts.ts` | Security prerequisite for any autonomy increase |
| Apple specialist roster: +32 markdown agents (UIKit/AppKit/SwiftData/CloudKit/WidgetKit/StoreKit/CoreML/HealthKit/watchOS/visionOS specialists + HIG/PrivacyManifest/entitlement/a11y/l10n/API-availability validators) | §26 §12 §16 | MISSING | S (config-only) | `org-template/agents/` | Expert density 26→58, zero code changes |

### C. Budget & control

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Budget engine: per-stage + per-run cost ceilings with halt (`OrgState.Stage.budget` + runner enforcement) | §4 §23 §30 | PARTIAL→build | M | cost propagation (exists) | #1 blocker for unattended runs |
| Cost prediction: pre-flight stage estimate from provider pricing catalog (`packages/llm/src/provider.ts` cost metadata) | §4 | MISSING | S–M | pricing catalog | "This stage ~$15" before spend |
| Escalation rules: cost/depth/retry thresholds → auto-inject human gate | §23 | MISSING | M | budget engine | Human oversight that scales with risk |
| Approval matrix: config-driven conditional gates in `organization.jsonc` (`approvalRules: [{stage, condition, gate}]`) | §23 §5 | MISSING | S | org schema ext | Replaces 2 hardcoded gates with policy |
| Cost-aware model ranking: sort fallback chain by $/token in `task.ts` resolveModel; extend chain beyond 2 levels | §3 §30 | PARTIAL | S | task.ts, provider costs | Cheapest capable model per call |
| Daily/monthly token quotas | §4 | MISSING | L | time-bucketed ledger | DEFER — ceilings + emergency stop suffice v1 |

### D. Workflow engine

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| DAG execution: `stage.requires[]` dependency graph replacing flat pipeline array; cycle validation | §5 | MISSING | M | schema + runner generalization | Multi-path runs; prerequisite for parallelism & consensus |
| Parallel stage scheduler (max-concurrency semaphore) | §5 §1(load balancing) | MISSING | M | DAG, timeout handling | ~40% wall-clock cut (frontend ∥ backend) |
| Retry + timeout policy: `stage.timeoutMs`, auto-retry N× with backoff before failing | §5 §3(retry) | MISSING/PARTIAL | S | org schema | Transient-failure resilience |
| Conditional branches: `stage.when` predicated on prior outputs | §5 | MISSING | M | DAG | Skip marketing in MVP mode; branch on feasibility verdict |
| Priority queue for stages | §5 | MISSING | S | — | DEFER — minor until portfolio scale |
| Dynamic pipeline generation (CEO composes pipeline at runtime) | §5 §1 | MISSING | L | DAG + conditionals | v2 |

### E. Agent registry & model routing

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Capability tagging: `skills[]`/`preferredTypes[]` on Agent.Info + frontmatter | §2 | MISSING | S | agent schema | Task→agent matching; auto-selection input |
| Per-agent metrics aggregation: cost, latency, success rate rolled up from session data | §1 §2 §24 §29 | MISSING | M | org-state→DB sync (see L) | Foundation for health, ranking, routing |
| Agent health scoring (error rate + latency thresholds) | §1 | MISSING | S–M | metrics aggregation | Input to future auto-replacement |
| Accuracy scoring + eval agent (per-deliverable rubric → `stage.score`) | §2 §29 | MISSING | L | outcome DB, postrun hook | v2 — enables quality-aware routing |
| Auto-selection / automatic ranking | §2 §3 | MISSING | L | tagging + metrics + accuracy | v2 |
| Latency-aware routing (provider response-time fallback) | §3 | MISSING | M | metrics | v2 |
| Benchmark harness: fixture orgs + SLA goals (`benchmark.jsonc`), metric emit | §29 | MISSING | M | metrics | v2 — SLA + regression detection |

### F. Memory, knowledge, RAG

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Postrun postmortem hook + lessons capture (`runner.ts` postrun → `.kilo/org/lessons.md` + memory) | §6 §25 | MISSING | M | runner.ts | Compounding learning; blocks all §25 follow-ons |
| Org-scoped shared memory: cross-run, dept-taggable pool searched before session memory | §6 §25 §27 | PARTIAL | M | kilo-memory | Later runs warm-start on earlier lessons |
| Org-scoped RAG: namespace/prefix-filtered index of run deliverables (no cross-project contamination) | §8 §9(artifact search) §21(cross-project search) §25(experience DB) | MISSING | M | kilo-indexing (exists) | "How did we solve auth last run?" answerable |
| Citation support in `semantic_search` output ("cite: file.ts:42") | §8 | MISSING | S | search tool | Audit trail for agent claims |
| Hybrid search (BM25 keyword + vector) | §8 | MISSING | M | LanceDB/Qdrant APIs | Recall on exact API names/paths |
| Architecture decision log: per-stage rationale extraction into indexed store | §6 | MISSING | M | postrun hook | Prevents decision drift across 26 agents |
| Coding/naming standards + tech-debt capture (derived from run outputs) | §6 | MISSING | M | org memory | Rolls into shared memory; not standalone |

### G. Artifact intelligence

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Version history + diff/rollback (build on reviseBaseline SHA-256; unified diff; snapshot restore) | §9 | PARTIAL | S | state.ts, runner.ts | 1-click restore; saves 10–30min per stuck stage |
| Artifact graph: parse deliverable cross-refs, reverse index, impact radius on revise | §9 | PARTIAL | M | state.json | Auto-invalidate downstream on rollback |
| Traceability metadata: agent/timestamp frontmatter in deliverables | §9 | PARTIAL | S | deliverable format | "Which agent wrote this, who approved" |

### H. Engineering runtime (Swift/Xcode)

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Build orchestration tool: xcodebuild/swift wrapper (scheme/target/config selection, output parsing) | §10 | PARTIAL (allowlists exist: `arity.ts`, `swiftui-dev-*.md`) | S | bash allowlists (in place) | CI-grade builds by agents |
| Simulator management tool: enumerate/boot/route on `xcrun simctl` | §10 | PARTIAL | S | simctl allowlist (in place) | Test parallelism per device |
| SwiftLint + SwiftFormat wrappers (`kilocode/tool/swiftlint.ts`) | §11 | MISSING | S–M | EXTERNAL CLIs | Lint gate on every build; style enforcement |
| Archive generation + IPA export (`xcodebuild archive` / `-exportArchive`) | §10 | MISSING | M | code signing (EXTERNAL) | The shippable artifact |
| Code signing + provisioning profiles | §10 §15(keychain) | EXTERNAL | XL setup | Apple Developer account, ASC keys, keychain | Hard gate on the entire release path |
| SPM automation beyond `swift build/test` (Package.resolved conflict detection) | §10 | PARTIAL | S | bash | Minor; as-needed |
| API deprecation + availability checkers (sourcekit-lsp diagnostics filter; `lsp/server.ts` spawns SourceKit) | §11 §26 | MISSING | M | sourcekit-lsp (wired) | Crash prevention across OS versions; v2 |

### I. Review, testing, debug

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Review stage + reviewer agents: senior-engineer, security, accessibility, privacy, App Store compliance (pipeline reorder: review before debugging) | §12 §15 §16(a11y) §26(validators) | MISSING | M (agents S each) | roster (B) + `organization.jsonc` reorder | Quality gate pre-ship; App Store rejection prevention |
| Multi-review consensus (parallel reviewers + vote aggregation) | §12 | MISSING | L | DAG parallelism (D) | False-positive reduction over single reviewer |
| Compliance validators as tools: PrivacyInfo.xcprivacy parser, ATS plist check, GDPR checklist | §15 §12 §26 | MISSING | S–M | plist parsing | Mandatory-for-submission checks automated |
| Snapshot testing (SnapshotTesting pkg integration) | §13 | MISSING | S | ui-tester | UI regression detection |
| Integration + regression suites (machine-readable regression list as artifact) | §13 | PARTIAL | M | test agents | Cross-boundary bugs; CI gate |
| Crash analysis + symbolication: `log show` → .crash → `dsymutil`/`atos` chain in debugger agent | §14 §19(dev-time) | PARTIAL | M | debugger agent, dSYM output | Readable post-mortems |
| Log aggregation (structured, searchable per-run log store) | §14 | MISSING | S | debugger | Root-cause history |
| Performance testing/profiling (Instruments .trace parsing, xccov) | §13 §14 | MISSING | L | Instruments (EXTERNAL-ish) | v2; v1 = human-gated manual Instruments |
| Offline + migration testing | §13 | MISSING | M/S | test agents | v1.5, add per-app as needed |

### J. Collaboration & governance

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Comments on stages/deliverables (session-DB thread table) | §22 | MISSING | M | session DB | Human annotation inline with gates |
| Notifications: Bus subscriber → desktop/webhook on `org.gate_awaiting`, `org.stage_completed`, budget breach | §22 §24 | MISSING | M | Bus (exists) | Kills polling; operator responsiveness |
| Escalation + approval matrix + audit — see C and B rows | §23 §22 | — | — | — | merged above |

### K. UX, visual, marketing, analytics

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| UX flow/wireframe visual rendering (text specs exist via ux-designer; add generate_image/SVG render) | §16 | PARTIAL | M | generate_image | Frontend handoff quality |
| Design system package + component library (+ Figma sync) | §16 | MISSING | L | Figma (EXTERNAL) | OPEN DECISION — heavy; text-spec may suffice v1 |
| Dynamic Type / Dark Mode / RTL validation (simctl env overrides in test runs) | §16 | MISSING | M | simulator tool (H) | HIG compliance; cheap once sim tool exists |
| Localization pipeline (string catalog extraction + translation API) | §18 §13 §26 | MISSING+EXTERNAL | L | translation service | Non-English markets; OPEN DECISION |
| Release notes generation | §18 §20 | PARTIAL (script/changelog.ts exists, CLI-invoked) | S | changelog script | Wire into marketing stage |
| Post-launch analytics: funnel/retention/KPI/experiments/revenue dashboards; crash reporter (Sentry/Crashlytics) | §19 §14 | EXTERNAL | L each | shipped app + service accounts | Defer to post-first-submission; crash reporter first |

### L. Delivery & observability

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Org console dashboard: per-run cost breakdown, stage timeline, status badges, decision history (`kilo-console` org route) | §24 §30 | PARTIAL | M–L | org-state→DB sync | Operator trust; visibility into all runs |
| Org state → session DB sync (state.json mirrored for queryable aggregation) | §24 | MISSING | S | schema addition | Enables dashboard + per-agent metrics without FS scans |
| Latency/success/failure metrics panels | §24 §1 §2 | PARTIAL (data exists) | S–M | DB sync | Bottleneck + reliability at a glance |
| ASC API client: auth, build upload, metadata POST, submission, review polling (fastlane-wrapped or direct) | §20 §10 | MISSING+EXTERNAL | L | Apple account, secrets mgmt | Autonomous shipping — the company's whole point |
| TestFlight upload | §10 §20 | MISSING+EXTERNAL | (in ASC client) | ASC client + signing | Beta distribution |
| Metadata upload + App Store submission + review monitoring (background poll job) | §20 | MISSING | M | ASC client | Closes marketing→ship loop |
| Release automation orchestration: post-gate auto-submit + rejected-metadata revise loop | §20 | MISSING | L | delivery items + budget engine | End-to-end autonomous release |
| Git autonomy: stage branches, commit templates tied to org stage, auto-PR | §20 §30 | PARTIAL | M | sandbox git | Traceable code flow per stage |

### M. Platform & learning

| Capability | Sections | Class | Size | Key dependency | Leverage |
|---|---|---|---|---|---|
| Tool registry / per-agent tool visibility (`tools:[]` in org schema; e.g. debugger cannot call org_decision) | §28 §23 | PARTIAL | S–M | org schema + permission matching | Least-privilege tools; also fixes tracked-followup on org-tool visibility |
| Plugin SDK formalization for org hooks (App Store Connect plugin, custom advisors) | §28 | PARTIAL | M | plugin/index.ts | Third-party extensibility |
| Prompt improvement pipeline (variant gen + A/B harness) | §25 | MISSING | L–XL | postmortem + eval agent | v2/v3 |
| Multi-project workspaces + shared agents (`projects:{}` in org schema v2) | §21 | MISSING | L | org schema v2 | v2 portfolio play |

---

## 2. FOUNDATIONS

Seven foundational capabilities; everything else in the map hangs off at least one of these.

**F1 — Budget engine** (C: ceilings + halt + prediction + emergency stop)
Files: `organization/state.ts`, `runner.ts`, `session/cost-propagation.ts`, `max-cost-nudge.ts`.
Unlocks → escalation rules (§23), cost-aware routing (§3), release-automation trust (§20), dashboard value (§24). *Nothing autonomous is safe to run unattended without this.*

**F2 — Org metrics substrate** (L: state→DB sync + per-agent/per-stage cost/latency/success aggregation)
Files: `packages/opencode/src/session/*.sql.ts`, `organization/state.ts`, kilo-console SDK.
Unlocks → dashboard (F7), health scoring (§1), ranking/auto-selection (§2), latency routing (§3), benchmarking (§29).

**F3 — DAG workflow executor** (D: `requires[]` + parallel scheduler + retry/timeout + conditional gates)
Files: `organization/schema.ts`, `runner.ts`, `org-template/organization.jsonc`.
Unlocks → parallel dev stages (§5), multi-review consensus (§12), approval matrix enforcement (§23), dynamic pipelines v2 (§5).

**F4 — Specialist agent roster** (B: +32 markdown agents — framework specialists + validators + reviewers)
Files: `org-template/agents/` only; validated by `OrgSchema.crossCheck()`.
Unlocks → review stage (§12), compliance gates (§15/§26), platform breadth (§26), a11y (§16). *Cheapest high-leverage move in the whole plan (~1 day, zero code).*

**F5 — Apple build & delivery toolchain** (H+L: build/simctl orchestration → SwiftLint → archive/IPA → ASC client → TestFlight/submission)
Files: `permission/arity.ts` (prefixes registered), `lsp/server.ts` (SourceKit wired), new `kilocode/tool/{xcode,simctl,swiftlint,ipa-export,asc}.ts`, `background-process/`.
Unlocks → the ship loop (§10 §20). **EXTERNAL hard gate: Apple Developer account + code signing (Open Decision #1).** Sequential internal chain: build → archive → IPA → TestFlight → submission → review monitoring.

**F6 — Postmortem + org memory/RAG** (F: postrun hook + org-scoped shared memory + namespaced index + citations)
Files: `organization/runner.ts` (postrun), `packages/kilo-memory/`, `packages/kilo-indexing/`.
Unlocks → lessons learned (§6), experience DB (§25), decision log (§6), prompt optimization v2 (§25), cross-project search v2 (§21).

**F7 — Org console dashboard** (L: cost/timeline/status per run + notifications)
Files: `packages/kilo-console/` (new org route), Bus.
Consumes F1+F2. Unlocks → operator trust, §24 wholesale, failure-pattern analysis. *The visibility that justifies letting the org run longer between gates.*

Dependency edges (what unlocks what):
```
tracked-followups(W0) ──> trust in F1/F2 numbers
F1 budget ──> escalation rules ──> longer unattended runs
F1 + F2 ──> F7 dashboard
F2 ──> health scoring ──> (v2) auto-replacement, auto-selection
F3 DAG ──> parallel scheduler ──> multi-review consensus (needs F4 roster)
F4 roster ──> review stage ──> quality gate before F5 ships anything
signing (EXTERNAL) ──> archive/IPA ──> TestFlight ──> submission ──> review monitor ──> release automation (needs F1)
F6 postmortem ──> lessons/decision log ──> (v2) prompt optimization, agent evolution
```

---

## 3. WAVE PLAN SKELETON

Every wave ends with working, demonstrable software on a real org run. Sizes are single-operator estimates.

### Wave 0 — Hardening & config wins (~1w) — closes: reliability baseline, §26, audit slice of §9/§22/§27, §4(stop)
- Fix the 5 real bugs in tracked-followups (A→B→A cost double-count via per-session cost map; org-tool visibility gating — pairs with tool-registry row M; depth-check-before-`ctx.ask`; +2).
- Audit export: `approvals.json` per run + `audit_log` read tool.
- Emergency stop (org-level kill).
- Prompt-injection sanitizer in `prompts.ts`.
- +32 specialist/validator agents in `org-template/agents/`.
- **Exit test:** full org run completes with correct cost totals; audit file produced; kill switch aborts a live run; new agents pass `crossCheck`.

### Wave 1 — Budget engine (~1–1.5w) — closes: §4 core, §23 core, §3 partial, §30 top item
- Stage/run ceilings + halt in runner; `budget` fields in schema + state.
- Pre-flight cost prediction from pricing catalog.
- Approval matrix (config-driven gates) + cost/retry escalation rules.
- Cost-aware fallback ranking in `task.ts` resolveModel; chain depth > 2.
- **Exit test:** run halts at $X ceiling; gate auto-injected on threshold breach; fallback chain demonstrably picks cheaper model on synthetic outage.

### Wave 2 — Build & test runtime (~1–1.5w) — closes: §10 local core, §11 core, §13/§14 partial
- Build orchestration tool (xcodebuild/swift wrapper + output parser).
- Simulator management tool (enumerate/boot/target).
- SwiftLint/SwiftFormat wrappers wired into dev/test agents.
- Snapshot testing; crash-log parse + symbolication chain (dsymutil/atos) in debugger agent; log aggregation (S).
- **Exit test:** org run autonomously builds, lints, and tests a real SwiftUI app on a booted simulator; a seeded crash produces a symbolicated trace in the debug deliverable.

### Wave 3 — Observability (~1–1.5w) — closes: §24 core, §22 notifications, metrics groundwork for §1/§2
- Org state → session DB sync.
- kilo-console org route: per-run cost breakdown, stage timeline, status/decision badges.
- Latency + success/failure panels; Bus→desktop/webhook notifications (gate-await, budget breach, stage complete).
- **Exit test:** live dashboard tracks a running org; a gate fires a notification; cost panel matches state.json to the cent.

### Wave 4 — Workflow DAG (~1.5–2w) — closes: §5 core, §1 (load balancing)
- `stage.requires[]` + cycle validation; runner generalized from array walk to graph executor.
- Parallel scheduler (concurrency cap); retry-with-backoff + `timeoutMs`; conditional branches (`stage.when`).
- **Exit test:** frontend ∥ backend stages run concurrently and rejoin at testing; a killed stage auto-retries twice then escalates; measured wall-clock improvement recorded.

### Wave 5 — Quality gate (~1.5w) — closes: §12, §15 validators, §16 a11y, §26 validators
- Pipeline reorder: insert `review` stage before debugging (`organization.jsonc`).
- Reviewer agents live (senior/security/a11y/privacy/compliance — from W0 roster); multi-review consensus via W4 parallelism.
- Compliance validator tools: PrivacyInfo.xcprivacy, ATS plist, App Store guideline checklist.
- **Exit test:** review stage blocks a seeded defect (hardcoded secret / missing privacy manifest); consensus report artifact delivered with per-reviewer votes.

### Wave 6 — Memory & learning foundation (~1.5w) — closes: §6, §25 core, §8 gaps, §9 (artifact search)
- Postrun postmortem hook → `.kilo/org/lessons.md` + org-scoped shared memory pool.
- Org-scoped RAG: namespace-filtered indexing of run deliverables; citations in `semantic_search`; architecture decision log extraction.
- (Optional if time: hybrid BM25 search.)
- **Exit test:** run 2 of the same org recalls run 1's lessons in CEO context; `semantic_search` over org runs returns cited artifact hits and nothing from unrelated projects.

### Wave 7 — Apple delivery pipeline (~2–3w, EXTERNAL-gated) — closes: §20, §10 remainder
- Prereq: Open Decisions #1/#2 resolved (account, signing strategy, fastlane vs direct ASC).
- Archive + IPA export; ASC client; TestFlight upload; metadata upload (with Apple length/locale validation in marketing prompts); submission; review-monitoring background job; release orchestration with revise loop.
- **Exit test:** an org run's build lands in TestFlight and its marketing metadata is posted to ASC without manual steps beyond the human gate approvals.

### Wave 8 — Registry & routing v2 (~2w) — closes: §2 core, §1 (health), §29 partial, §9 remainder
- Capability tagging; per-agent metrics/health scoring on F2 data; benchmark harness (fixture org + SLA goals).
- Artifact graph + version rollback; hybrid search if not done in W6.
- **Exit test:** agent scoreboard renders in console; rollback restores a prior deliverable and invalidates downstream artifacts.

### Horizon (v2+ backlog, in rough order)
Auto-selection/ranking, accuracy scoring + eval agent, latency/quality-aware routing, prompt-improvement pipeline, dynamic pipeline generation, multi-project portfolio + shared agents, localization pipeline, design system package, crash-reporter integration + post-launch analytics, performance testing (Instruments automation), agent auto-replacement, policy tuning/agent evolution.

---

## 4. CUT LIST (SNR filter raw material)

### Rejected (QUESTIONABLE — do not build)
| Item | Sections | Reason |
|---|---|---|
| Matrix organization / cross-functional squads / agent transfer / multiple chiefs | §1 | Conflicts with the hierarchical depth model; org.jsonc is user-editable for ad-hoc needs; zero single-operator ROI |
| Multi-model consensus / ensemble execution | §3 | Parallel frontier calls are token-expensive on BYOK; retry + fallback is sufficient |
| Hallucination scoring | §2 | Needs fact-check infra; high false-positive risk; no grounding data yet |
| Agent retirement / vacation handling | §1 | Permission-deny is a free workaround for a solo operator |
| ROI estimation + budget optimization loop | §4 | Needs weeks of runs with outcome tracking that doesn't exist yet |
| Worker stealing | §5 | No parallel stages exist until W4; revisit only if scheduler proves imbalanced |
| WWDC video indexing | §7 | XL (transcription/ASR/storage); webfetch a specific video when needed |
| Pre-built internal playbooks | §7 | Will emerge from indexed run outputs (W6); don't pre-author |
| Deliverable semantic-schema validation | §9 | 50-char check + human gates suffice; revisit at 10+ projects |
| Standalone full-text artifact search / portfolio web dashboard | §9 §21 | Subsumed by W6 org-RAG and grep; console duplication otherwise |
| Thread-safety analysis + memory-leak/leak-detection agents | §11 §14 | No sourcekit-lsp support; Instruments GUI isn't scriptable — keep as manual human-gate step |
| Complexity analysis / naming-rule engine | §11 | LSP + apple-docs + SwiftLint cover ~80%; custom analyzers are low signal |
| Stress/load testing | §13 | No multi-user backend in scope; inapplicable |
| Mentions + assignments | §22 | Fixed CEO→chief→worker structure removes assignment friction |
| Device frame rendering / social media assets / animation review | §17 §16 | Polish, not critical path; simctl output + generate_image suffice |
| Revenue forecasting | §18 | No historical data; pricing-analyst output is enough for v1 |
| Agent heatmap | §24 | Needs 5–10 accumulated runs to mean anything; v2 |
| Screenshot upload automation (v1) | §20 | Spec-only from preview-designer; human uploads via ASC UI; automate in v2 if designer agents mature |
| Plugin marketplace | §28 | Scales at 100+ users; share agents via git meanwhile |
| Distributed multi-machine org | §30 | Local .kilo/ + BYOK is the v1 shape; cloud persistence is a different product |
| Worker self-delegation / dynamic role swapping | §30 | Subordinates as hard boundaries IS the v1 control surface |
| Full governance policy engine / org self-improvement loop / auto policy tuning / agent evolution / automatic prompt optimization | §23 §25 §29 §30 | All presuppose stable metrics + eval + postmortem (W3/W6/W8); Phase 3 at earliest |
| Continuous scheduled benchmarking | §29 | Duplicates CI; lightweight telemetry export only |
| Dynamic department creation / org templates registry | §1 | Static org + editable jsonc covers v1; revisit with multi-project |

### Deferred (EXTERNAL — real value, blocked on accounts/services/shipped app)
| Item | Sections | Blocker |
|---|---|---|
| Code signing + provisioning + keychain workflows | §10 §15 | Apple Developer account, certs, ASC keys, secrets management (Open Decision #1) |
| TestFlight/ASC pipeline | §10 §20 | Same + fastlane-vs-direct decision (#2) — scheduled W7, not cut |
| Post-launch analytics (funnel/retention/KPI/experiments/revenue) | §19 | Shipped app + analytics platform; separate post-submission system |
| Crash reporter (Sentry/Crashlytics) | §19 §14 | Service account + data policy (Open Decision #7) |
| Localization pipeline | §18 §13 §26 | Translation service + market decision (#6) |
| Design system + Figma sync | §16 | Figma account/API + investment decision (#5) |
| SSO / enterprise deployment / billing service | §27 | Fork is BYOK CLI, no auth layer; commercial-offering scope only |
| Daily/monthly quotas | §4 | Calendar-keyed ledger; ceilings + stop cover v1 risk |
| Secret scanning / keychain review tooling | §15 | v2 security harness; code-review discipline + sanitizer (W0) cover v1 |

---

## 5. OPEN DECISIONS (product-owner only)

1. **Apple Developer account + signing strategy.** Provision the account, certificates, ASC API key; choose fastlane `match` vs manual Xcode signing vs direct ASC-key flow; decide where secrets live (env-injected via CI vs local keychain — never in agent configs). Gates all of Wave 7.
2. **fastlane wrapper vs direct ASC API client.** ~1.5w (fastlane dep, battle-tested) vs ~2.5w (no Ruby dep, full control). Affects W7 scope and long-term maintenance.
3. **Cloud/enterprise scope confirmation.** Ratify the cut of SSO/billing/multi-tenant/distributed-org for this fork (BYOK single-operator). If a commercial offering is intended within 6 months, F2/F7 schema choices should anticipate multi-tenant now.
4. **Vector store + embedder for org-RAG.** LanceDB local (default, private, free) vs Qdrant remote (scales, ops cost); Ollama local embedder vs API embedder ($ + data egress). Privacy/cost call for W6.
5. **Design system investment.** Build the design-system package + Figma integration (L, EXTERNAL) or stay text-spec-driven for v1 apps. Affects UX department output quality and frontend agent consistency.
6. **Localization scope.** v1 English-only (assumed) or committed target locales? If locales are wanted, localization must land before the marketing stage generates final listings — deciding late means rework.
7. **Crash reporting vendor.** Sentry vs Firebase Crashlytics vs TestFlight-feedback-only for first shipped apps (data policy + cost + SDK weight in generated apps).
8. **Default budget policy values.** Per-run ceiling, per-stage ceiling, escalation threshold ($X → auto-gate), retry counts. These encode the owner's risk appetite; Wave 1 ships with these as config defaults.
9. **Pipeline reorder approval.** Inserting the review stage before debugging (W5) changes org-template for all future runs and the meaning of the existing gates — explicit sign-off needed since it alters the v1 contract.
10. **Multi-project timing.** Portfolio/multi-project (§21) is v2 in this plan; confirm no near-term need for a second concurrent project under one CEO, otherwise W8 must pull the org-schema-v2 work forward.

---

*Synthesized 2026-07-10 from 10 cluster reports: org-registry-router, budget-workflow, memory-knowledge-rag, artifacts-multiproject, engineering-runtime, review-testing-debug, security-governance-collab, ux-visual-marketing-analytics, delivery-observability, learning-experts-platform, vision-architecture.*
