# EPIC 4 — Generalize: iOS Factory → General Org Platform (toolpacks + templates)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Make the iOS-specific content pluggable — bundle Apple tools+agents into an `apple-delivery` toolpack (org opt-in), and turn the single org-template into a template system (`ios-app-factory`, `blank`, `research-desk`, `content-studio`) scaffolded by `northstar org init --template <name>`. The org kernel is already generic (audit-confirmed) — do NOT refactor schema/state/runner.

**Branch:** `feat/generalize-org` (off main `e22e18b5c4`).

**Acceptance (exit):** `northstar org init --template research-desk` scaffolds `.kilo/`; that org passes `--dry-run`/validate and a toy pipeline completes in a fixture run; `ios-app-factory` is byte-preserved (template.test.ts still sees 11 stages / 63 agents); a non-iOS org does NOT see the Apple tools (`applyVisibility` hides them); the Apple tools ARE visible when `toolpacks:["apple-delivery"]`.

**Conventions:** `bun` at `~/.bun/bin`. Test from `packages/opencode/`. Typecheck `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'`. NEVER stage `bun.lock`. `// kilocode_change` on non-exempt shared-file edits. Push `--no-verify`.

---

## Task 4.1 — Toolpack mechanism (org-level opt-in, `apple-delivery`)
**Files:** Create `packages/opencode/src/kilocode/tool/toolpacks.ts`; modify `packages/opencode/src/kilocode/organization/schema.ts` (`Organization` ~L41-49); modify `packages/opencode/src/kilocode/tool/registry.ts` (`applyVisibility` ~L467-476, add `toolpackEnabled` near `orgToolsEnabled` ~L440); test.

- [ ] **RED:** a registry test — with an org whose `organization.jsonc` has NO `apple-delivery` in `toolpacks`, `applyVisibility` HIDES the Apple tool ids (xcode_build, asc_submit, …); with `toolpacks:["apple-delivery"]`, they're visible. And a non-org project (no organization.jsonc) hides them.
- [ ] **GREEN — toolpacks.ts:** `export const TOOLPACKS: Record<string, { toolIds: Set<string>; agents: string[] }>` with `"apple-delivery"` = `{ toolIds: new Set(["xcode_build","xcode_test","xcode_archive","ipa_export","crash_symbolicate","privacy_manifest_check","ats_check","asc_metadata_validate","asc_submit","asc_status"]), agents: [<the ~50 Apple agents>] }`. **`secret_scan` stays in base (NOT the pack).** Build `TOOLPACK_BY_TOOL_ID: Map<string, string>` (reverse index).
- [ ] **GREEN — schema.ts:** add `toolpacks: z.array(z.string()).default([])` to `OrgSchema.Organization`.
- [ ] **GREEN — registry.ts:** add `toolpackEnabled(ctx, pack)` cloned from `orgToolsEnabled` (~L440) — reads `organization.jsonc`, returns `org.toolpacks.includes(pack)`, 5s TTL cache. In `applyVisibility` (~L471-475) add: `const pack = TOOLPACK_BY_TOOL_ID.get(tool.id); if (pack) return <toolpackEnabled result>`. Keep `extra()` building the tools unconditionally (they must exist when the pack is on). Note: org_* gates on organization.jsonc EXISTENCE, apple-delivery on its CONTENT — independent gates.
- [ ] Verify (registry + org tests green; the 3 tool-registry-indexing fixtures still pass — the tool LIST is unchanged, only per-turn visibility differs) + commit: `feat(generalize): apple-delivery toolpack — org-level opt-in gates Apple tool visibility`.

## Task 4.2 — Template restructure (org-template → templates/ios-app-factory, byte-preserved)
**Files:** `git mv org-template templates/ios-app-factory` (byte-preserve); add `toolpacks:["apple-delivery"]` to `templates/ios-app-factory/organization.jsonc`; repoint the 4 hardcoded test constants; doc strings; `packages/opencode/package.json` `files`.
- [ ] `git mv org-template templates/ios-app-factory`. Add `"toolpacks": ["apple-delivery"]` at the top of `templates/ios-app-factory/organization.jsonc` (the ONLY content change — everything else byte-identical so template.test.ts's 11-stage/63-agent pins hold).
- [ ] **Repoint the 4 test constants** `path.resolve(import.meta.dir, "../../../../..", "org-template")` → `.../templates/ios-app-factory`: `test/kilocode/organization/template.test.ts:13`, `build-allowlist.test.ts:10`, `write-path.test.ts:27`, `wave5-exit.test.ts:294`. (Adjust the relative depth for the new path.)
- [ ] **Doc strings:** `schema.ts:257` loader error ("cp -r org-template/. .kilo/") → "run `northstar org init --template <name>`"; `templates/ios-app-factory/README.md`; `organization.jsonc:2` comment.
- [ ] **Packaging:** add `templates/` to `packages/opencode/package.json` `files` (or the build's asset copy) so `org init` can resolve it in an installed binary. Verify the build includes it (check build.ts asset copy — mirror how `console`/tree-sitter assets are bundled).
- [ ] Verify (template.test.ts green — 11 stages/63 agents; the 4 repointed tests green; typecheck) + commit: `feat(generalize): move org-template -> templates/ios-app-factory (+apple-delivery toolpack), repoint tests/docs/packaging`.

## Task 4.3 — `northstar org init --template <name>` command
**Files:** Create `packages/opencode/src/kilocode/cli/cmd/org.ts`; register in the CLI setup (`KiloCli.register`, setup.ts ~L30-44); test.
- [ ] Study `roll-call.ts` (or another `cmd({...})` subcommand) + `setup.ts` register pattern. Create `OrgCommand = cmd({ command: "org", builder: y => y.command(OrgInitCommand).demandCommand(), ... })` with `OrgInitCommand = cmd({ command: "init", builder: y => y.option("template", { type:"string", default:"ios-app-factory" }).option("force",{type:"boolean"}), handler })`. Register `.command(OrgCommand)` in setup.ts.
- [ ] Handler: (1) resolve the bundled `templates/` dir from the INSTALL root (like `Global.Path`/`__dirname`/`import.meta.dir` relative to the binary), NOT CWD; (2) validate `<name>` exists (list available on miss); (3) refuse if `./.kilo/organization.jsonc` exists unless `--force`; (4) recursively copy `templates/<name>/.` → `./.kilo/`; (5) run `OrgSchema.loadOrganization` + `validate` on the result and print a summary (dept/stage/agent counts).
- [ ] Verify (a test: `org init --template blank` into a tmpdir scaffolds a valid `.kilo/` that loadOrganization accepts; `--force` guard; unknown template errors cleanly) + commit: `feat(generalize): northstar org init --template scaffolds .kilo/ from a template`.

## Task 4.4 — Non-iOS templates (blank, research-desk, content-studio)
**Files:** Create `templates/blank/`, `templates/research-desk/`, `templates/content-studio/` — each with `organization.jsonc` + `agents/*.md` + `command/*.md` + `README.md`. Each MUST pass `OrgSchema.validate` + `crossCheck`.
- [ ] **blank:** minimal but valid — a CEO + 1 department (1 chief + 1 worker) + a 1-stage pipeline; a generic `command/run.md`. (loadOrganization requires a ceo + ≥1 stage — can't be empty.)
- [ ] **research-desk (exit-critical, must RUN):** a research org — e.g. CEO → research-chief (scope→research→synthesize) + a review gate; agents: research-chief, researcher(s), analyst, editor/reviewer; pipeline stages named freely (scope, research, synthesize, review). Every agent pins a `model`, `permission` task starts `"*": deny`, chief `subordinates` ⊇ workers+shared. `command/research.md`. NO apple-delivery toolpack.
- [ ] **content-studio:** a content org — CEO → editorial-chief (brief→draft→edit→review); agents: editorial-chief, writer(s), editor, fact-checker/reviewer. `command/write.md`.
- [ ] For EACH template, run `OrgSchema.loadOrganization` + `validate` + `crossCheck` (write a per-template consistency test mirroring template.test.ts's assertions) → all green. Keep each `command/` flat.
- [ ] Verify + commit: `feat(generalize): blank + research-desk + content-studio org templates (validate/crossCheck green)`.

## Task 4.5 — Kernel cosmetic copy + exit test + review-prep
**Files:** `packages/opencode/src/kilocode/organization/prompts.ts` (~L42 "App idea", ~L54 "Apple platform/API/HIG"); `tools.ts` (~L163/174 "app idea"); create `test/kilocode/organization/epic4-exit.test.ts`.
- [ ] **prompts.ts:** replace the iOS-specific labels with neutral/template-supplied text — "App idea" → "idea/brief"; the "Apple platform/API/HIG questions" consultant label → a generic "domain/consultant" phrasing (so a non-iOS org renders neutral prompts). Keep behavior identical; adjust any snapshot.
- [ ] **Exit test:** (a) drive the `research-desk` org through the deterministic fixture runner (like `OrgBenchmark`/wave-exit tests) — write ≥50-char deliverables per stage, auto-answer gates → run reaches `done` (toy pipeline completes). (b) assert `applyVisibility` hides the Apple tools for the research-desk org (no apple-delivery) and shows them for ios-app-factory (has it). (c) `org init --template research-desk` into a tmpdir → valid `.kilo/`.
- [ ] Verify (epic4-exit green; template.test.ts still 11/63 for ios-app-factory; full org suite green or isolation-confirmed; typecheck; guards) + `.changeset/`; commit: `test(generalize): EPIC 4 exit — research-desk runs, apple-delivery gated, org init scaffolds`.

## Self-review
- toolpack opt-in → 4.1 ✓ · template system + init → 4.2/4.3 ✓ · 4 templates → 4.2 (ios) + 4.4 (3) ✓ · generic kernel (cosmetic only) → 4.5 ✓ · exit (research-desk runs + apple gated + ios preserved) → 4.5 ✓.
- **Deferred:** per-agent toolpacks (org-level suffices); moving the ~50 Apple agent files OUT of the base (they live in the ios-app-factory template already after the move — the other templates just don't include them).
- **Risks:** byte-preserve ios-app-factory (4.2 — template.test pins 11/63); each new template must pass crossCheck (4.4); `org init` install-path resolution + packaging (4.3/4.2 — templates not currently shipped). Sequence 4.1 → 4.2 → 4.3 → 4.4 → 4.5.
