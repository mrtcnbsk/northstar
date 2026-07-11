# EPIC 1 — Deep Rebrand: Kilo → northstar (@ilura/northstar)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox (`- [ ]`) steps.

**Goal:** Rename the published CLI, binary, config file/dir, env vars, installer, self-update source, and user-facing brand copy from "Kilo"/"Kilo Code" to "northstar" (publisher Ilura Technology OÜ), with back-compat so existing installs/config keep working.

**Branch:** `feat/rebrand-northstar` (off main `d3432e97e7`). **Roadmap:** `docs/superpowers/plans/2026-07-11-epic-roadmap.md` EPIC 1 (+ folds in EPIC 3.3 trademark cleanup).

**Acceptance (EPIC-level exit):** `bun run build` (from `packages/opencode/`) → a `northstar` binary; `northstar --version` works; CI guards (check-opencode-annotations, check-forbidden-strings, check-workflows, check-kilo-generated-artifacts, check-kilocode-change) stay green; an existing `~/.config/kilo/kilo.jsonc` still loads (back-compat).

## HARD CONSTRAINTS (never violate — verified by the substrate map)
1. **Do NOT rename the `@kilocode/*` workspace namespace** (881 refs; @kilocode/sdk, kilo-console, kilo-indexing, kilo-memory, kilo-gateway, …). ONLY the published CLI package `@kilocode/cli` (`packages/opencode/package.json` name) + its per-platform siblings `@kilocode/cli-<os>-<arch>` become `@ilura/northstar[-*]`.
2. **Do NOT touch the literal `kilocode_change`** (4560 CI-enforced provenance markers). Edit the code on a marked line but keep the marker.
3. **Do NOT rename the `.kilo/` or `.kilocode/` PROJECT dirs** (org kernel: `.kilo/organization.jsonc`, `.kilo/org/runs/`, `.kilo/agents/`; + `check-kilo-generated-artifacts` guard). These are distinct from the global config dir and the install dir.
4. **Do NOT relocate data/cache/state/DB/logs** — `packages/core/src/global.ts:11 app="kilo"` drives ALL XDG dirs; a blanket flip orphans the user's sqlite DB + sessions. Rename ONLY the config dir (decoupled), leave data/state on `kilo`.
5. **Do NOT rename backend infra identifiers** in `src/cli/cmd/github.ts` (kiloconnect[bot], api.kilo.ai, OIDC audience) or hosting URLs (app.kilo.ai/config.json `$schema`, kilo.ai/cli/install) — these are live infra / EPIC-2 domain decisions. DEFER (track as EPIC-1 follow-ups).
6. **Non-exempt shared-file edits** (outside `src/kilocode/**` and non-`kilo-*` packages) MUST be wrapped in `// kilocode_change` or `check-opencode-annotations` goes red.

**Conventions:** `bun` at `~/.bun/bin`. Test from `packages/opencode/` (`bun test`, NEVER root). Typecheck `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'`. Lint `bun run lint`. NEVER stage `bun.lock`. `.changeset/<slug>.md` for user-facing changes. Push `--no-verify` (locale jetbrains hook). Clean `opencode-test-*` temp after tests.

---

## Task 1.1 — Published identity + binary name
**Files:** `packages/opencode/package.json` (name:4, bin:21-24); `packages/opencode/bin/kilo` (→ `bin/northstar` via `git mv`; internal `base="@kilocode/cli-"`→`@ilura/northstar-`, binary basename `kilo`/`kilo.exe`→`northstar`).
- [ ] Set `name` → `@ilura/northstar`; `bin` → `{ "northstar": "./bin/northstar" }` (drop `kilo`/`kilocode` bin keys). `git mv bin/kilo bin/northstar`; update its `base` prefix + binary basename.
- [ ] Verify no code imports the package by its old published name `@kilocode/cli` at runtime (grep; the internal workspace refs use `@kilocode/*` deps, unaffected). `packages/script/src/index.ts:61` registry URL `@kilocode/cli`→`@ilura/northstar`.
- [ ] Verify + commit: `feat(rebrand): publish as @ilura/northstar with northstar binary`.

## Task 1.2 — Config dir + file names + env vars (back-compat) — THE delicate one, TDD
**Files:** `packages/core/src/global.ts:11-26` (config dir decouple); `packages/core/src/flag/flag.ts:35-120` (dual-read env); `packages/opencode/src/kilocode/config/config.ts:41,44,47,326` + `packages/opencode/src/config/config.ts:480,636-642,478-488` (config-file arrays); `packages/opencode/src/kilocode/config-injector.ts:113` (KILO_CONFIG_CONTENT writer); `packages/opencode/src/kilocode/indexing-auth.ts:90,97` (KILO_API_KEY/ORG_ID); `packages/opencode/src/kilocode/config/sources.ts:59-60,109,114,173,277` (labels).
- [ ] **Config file (RED first):** prepend `northstar.jsonc`/`northstar.json` (highest precedence) to `KILO_CONFIG_FILES`(41)/`ALL_CONFIG_FILES`(44)/`GLOBAL_CONFIG_FILES`(326) and the `config.ts` candidate list (480, globalConfigFile 478-488) — **KEEP `kilo.jsonc`/`kilo.json`** in the arrays (back-compat). Test: `northstar.jsonc` loads; an existing `kilo.jsonc` still loads.
- [ ] **Config dir (decoupled, back-compat):** in `global.ts`, derive `config` from a `northstar` name while data/cache/state/tmp/log/bin/repos stay on `app="kilo"` (do NOT relocate them). Add `~/.config/kilo` as a back-compat READ candidate wherever the global config dir is read (config.ts loaders / paths.ts `directories()`), writing to `~/.config/northstar`. Test: new global config resolves under `~/.config/northstar`; an existing `~/.config/kilo/kilo.jsonc` still loads; the sqlite DB path is UNCHANGED (still `kilo`).
- [ ] **Env (dual-read helper):** add `env(newKey, oldKey) = process.env[newKey] ?? process.env[oldKey]` in `flag.ts`; convert config-critical flags to `NORTHSTAR_*` primary + `KILO_*` fallback: `KILO_CONFIG`, `KILO_CONFIG_CONTENT`, `KILO_CONFIG_DIR`, `KILO_DISABLE_PROJECT_CONFIG`, `KILO_TUI_CONFIG`, `KILO_API_KEY`, `KILO_ORG_ID` (indexing-auth.ts). Update `config-injector.ts:113` WRITER to emit `NORTHSTAR_CONFIG_CONTENT` (and keep `KILO_CONFIG_CONTENT` too, or migrate reader+writer together). Update `sources.ts` labels. (Leave the ~120 non-config `KILO_*` flags for a follow-up unless trivial via the helper — but the helper makes a blanket dual-read cheap; prefer converting all via the helper with KILO_* fallback.) Test: `NORTHSTAR_CONFIG` honored; `KILO_CONFIG` still honored (fallback).
- [ ] Verify (org + config suites green, back-compat tests) + commit: `feat(rebrand): northstar.jsonc + ~/.config/northstar + NORTHSTAR_* env, all with kilo back-compat`.

## Task 1.3 — Installer + uninstaller
**Files:** `install:3,70,71,186-203,225-355,13-26` (APP, INSTALL_DIR, URLs, binary, branding); `packages/opencode/src/cli/cmd/uninstall.ts:269,297,303` (`.kilo/bin` PATH strip).
- [ ] `install`: `APP=kilo`→`northstar`; `INSTALL_DIR=$HOME/.kilo/bin`→`$HOME/.northstar/bin`; `mv/chmod` binary → `northstar`; `command -v kilo`/`kilo --version` → `northstar`; the 3 `Kilo-Org/kilocode` GitHub URLs → `mrtcnbsk/northstar`; usage/branding text "Kilo Code Installer" → northstar (keep `# kilocode_change` markers on marked lines). DEFER the `kilo.ai/cli/install` hosting URL (EPIC 2).
- [ ] `uninstall.ts`: match `$HOME/.northstar/bin` for PATH strip AND keep matching the old `.kilo/bin` (back-compat — cleans up prior installs).
- [ ] Verify (`bun test` uninstall-adjacent; shellcheck install if available) + commit: `feat(rebrand): installer + uninstaller target northstar / $HOME/.northstar/bin`.

## Task 1.4 — Build / publish + self-update source
**Files:** `packages/opencode/script/build.ts:320,321,365,376,437,423`; `packages/opencode/script/publish.ts:56-58,73,88` (defer AUR/Homebrew tap provisioning — code-edit the names, note channels need external setup); `src/kilocode/installation/index.ts:1-26` (Npm.name, Release.api, Release.install, Brew/Choco/Scoop); `src/installation/index.ts:64,194`.
- [ ] `build.ts`: hard-coded binary basename `kilo`→`northstar` (outfile 320, user-agent 321, patchelf 365, smoke 376, archive `.replace(pkg.name,"kilo")` 437); embedded `repository.url` 423 `Kilo-Org/kilocode`→`mrtcnbsk/northstar`. (compile.target 318 auto-follows pkg.name — leave.)
- [ ] `publish.ts`: bin block, `repository.url`, ghcr image → northstar/mrtcnbsk. Per-platform names auto-derive from pkg.name (leave). Track AUR/Homebrew/ghcr channel provisioning as EPIC-2 external actions.
- [ ] **Self-update (highest impact):** `src/kilocode/installation/index.ts` — `Npm.name`→`@ilura/northstar` (+ `path` `@ilura%2fnorthstar`), `Release.api`→`api.github.com/repos/mrtcnbsk/northstar/releases/latest`, Brew/Choco/Scoop names. `src/installation/index.ts:64` userAgent `kilo/`→`northstar/`, `:194` `.kilo/bin` curl-detection → `.northstar/bin`. (Note: self-update will find no releases until EPIC 2 ships the pipeline — expected.)
- [ ] Verify (`bun turbo typecheck`; `bun run build` produces a `northstar` binary + `northstar --version`) + commit: `feat(rebrand): build/publish + self-update source → @ilura/northstar / mrtcnbsk/northstar`.

## Task 1.5 — User-facing brand copy (+ EPIC 3.3 trademark cleanup)
**Files:** the ~4 opencode/src files with "Kilo Code" brand copy (help/version/UI footers) + `install` branding (done in 1.3). Grep `"Kilo Code"` and user-facing `Kilo-Org/kilocode` in help/UI (EXCLUDE NOTICE provenance, `script/upstream/**`, `patches/**`, `.kilo/agent/upstream-merge.md`, and the DEFERRED github.ts backend identifiers + hosting URLs).
- [ ] Replace user-facing "Kilo Code"/"Kilo" product copy → "northstar" (wrap non-exempt shared-file edits in `// kilocode_change`). Keep upstream attribution (LICENSE/NOTICE/README lineage) intact.
- [ ] Verify (`bun run script/check-opencode-annotations.ts` green; grep confirms backend/hosting/attribution untouched) + commit: `feat(rebrand): user-facing brand copy Kilo Code → northstar (attribution preserved)`.

## Task 1.6 — Assets (text/ASCII branding; image logos = user-provided)
- [ ] Update TUI/CLI TEXT/ASCII logo + product-name strings to "northstar" where they're code/text. **The actual `logo.png` (and any binary logo image) is a design asset the owner must provide** — leave a placeholder + note (like the npm reservation, it's a user deliverable). Record in the EPIC-1 follow-ups.
- [ ] Commit (if any text changes): `feat(rebrand): text/ASCII branding → northstar (image logo pending owner asset)`.

## Task 1.7 — Exit test + full verification
- [ ] `bun run build` (from `packages/opencode/`) → confirm a `northstar` binary is produced; run `./<binary> --version` → prints a version.
- [ ] Back-compat exit test: an existing `~/.config/kilo/kilo.jsonc` + a `KILO_CONFIG`/`KILO_API_KEY` env still load (a unit test asserting the fallback path).
- [ ] CI guards all green: `bun run script/check-opencode-annotations.ts`, `check-forbidden-strings`, `bun run script/check-workflows.ts`, `check-kilo-generated-artifacts`, `check-kilocode-change`.
- [ ] Full org/config sweep green (or isolation-confirmed if the machine is loaded — see the W9 environmental-sweep lesson). Typecheck + lint clean. `.changeset/` entry for the rename.
- [ ] Commit: `test(rebrand): EPIC 1 exit — northstar binary + build + config/env back-compat + guards green`.

## Self-review (plan vs. acceptance)
- northstar binary + `--version` → 1.1 + 1.4 + 1.7 ✓ · config/env back-compat → 1.2 + 1.7 ✓ · guards green → 1.5 + 1.7 ✓ · installer/self-update → 1.3 + 1.4 ✓ · brand copy → 1.5 ✓.
- **Deferred (tracked follow-ups):** github.ts backend identifiers (live infra), hosting URLs (kilo.ai/cli/install, app.kilo.ai `$schema` — EPIC 2 domain), AUR/Homebrew/ghcr channel provisioning (external), the actual logo.png image (owner asset), and the ~120 non-config `KILO_*` flags if not swept via the helper.
- **Sequencing:** 1.1 → 1.2 (config, delicate) → 1.3 → 1.4 → 1.5 → 1.6 → 1.7. One implementer at a time. 1.2 is the highest-risk (back-compat + not orphaning the DB) — verify hard.
