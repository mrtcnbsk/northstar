# EPIC 2 — Terminal-only Release Pipeline (npm-only)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Strip VSCode/JetBrains/Docker/AUR/Homebrew from the release pipeline; ship npm-only + a `curl|bash` install from the raw GitHub URL. Repo `mrtcnbsk/northstar`, package `@ilura/northstar`.

**Branch:** `feat/release-terminal-only` (off main `9df398c7af`). **Decisions:** npm-only channels; install host = `https://raw.githubusercontent.com/mrtcnbsk/northstar/main/install` (repo is now PUBLIC → anonymous curl works).

**Scope note:** EPIC 2 strips the RELEASE/CI for VSCode/JetBrains, it does NOT delete the `packages/kilo-vscode` / `packages/kilo-jetbrains` source (leave them; they just stop being built/published). Package deletion is a possible later cleanup.

**Acceptance:** `check-workflows` guard green after the workflow set changes; `bun run script/publish.ts --preview` (dry/preview) runs the npm path with no docker/AUR/homebrew/vsce; README shows the npm + curl one-liner; `bun turbo typecheck` + guards green. (Actual publish needs NPM_TOKEN + the npm name reservation — your action.)

**Conventions:** `bun` at `~/.bun/bin`. Test from `packages/opencode/`. Typecheck `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'`. NEVER stage `bun.lock`. `// kilocode_change` on non-exempt shared-file edits. Push `--no-verify`.

---

## Task 2.1 — CI workflow surgery (publish.yml + delete 6 workflows + prune jetbrains/vscode jobs + check-workflows allowlist)

**Files:** `.github/workflows/publish.yml`; DELETE `prepare-jetbrains-release.yml`, `publish-jetbrains.yml`, `test-jetbrains.yml`, `test-vscode.yml`, `containers.yml`, `codeql-kotlin.yml`; edit `.github/workflows/test.yml`, `typecheck.yml`, `visual-regression.yml`; `script/check-workflows.ts`.

- [ ] **publish.yml:** repo guard `Kilo-Org/kilocode` → `mrtcnbsk/northstar` (jobs version:45, build-cli:81, smoke-test:377; remove the build-vscode job:323-367 entirely). Delete the `build-vscode` job. `publish.needs` (385-391): remove `build-vscode` (388). In the `publish` job steps, REMOVE: docker login/qemu/buildx (402-413), `@vscode/vsce` install (421-422), download `kilo-vscode` artifact (445-448), AUR apt cache (450-456) + SSH (458-467); in the `run publish.ts` step (469-479) strip env `AUR_KEY`, `VSCE_PAT`, `OPENVSX_TOKEN` (keep `NPM_CONFIG_PROVENANCE`, `KILO_VERSION/RELEASE/PRE_RELEASE`, `GH_REPO`, `GITHUB_TOKEN`). In the `version` job, drop the vestigial `KILO_API_KEY`/`KILO_ORG_ID` env (71-72). Fix the `bun i -g @kilocode/cli` (59) → `@ilura/northstar`.
- [ ] **DROP smoke-test:** `smoke-test.yml` needs the private `Kilo-Org/kilo-bench` repo + `KILO_API_KEY`/`KILO_ORG_ID`/`BENCH_GITHUB_TOKEN` we don't have, and it gates `publish`. Remove `smoke-test` from `publish.needs` (391) AND delete the `smoke-test` job (372-382). (Leave `smoke-test.yml` file? It's now unreferenced — either delete it + remove from allowlist, or keep. Cleanest: delete it too. Decide + keep check-workflows consistent.)
- [ ] **Delete the 6 workflow files** (jetbrains/vscode/docker/kotlin-codeql).
- [ ] **Prune broken references:** `test.yml` (jetbrains job ~178-184 calls `test-jetbrains.yml`; aggregate ~193/199/201 asserts `needs.jetbrains.result==success`) — delete the jetbrains job + its aggregate refs. `typecheck.yml` (jetbrains-changes + typecheck-jetbrains + aggregate ~30-100) — prune. `visual-regression.yml` (`visual-regression-vscode` job ~220-270 depends on kilo-vscode webview) — delete that job (keep the workflow). Verify each edited workflow's remaining `needs`/aggregate graph is consistent.
- [ ] **check-workflows.ts `active` set (29-57):** remove the deleted files: `codeql-kotlin.yml`, `containers.yml`, `prepare-jetbrains-release.yml`, `publish-jetbrains.yml`, `test-jetbrains.yml`, `test-vscode.yml` (+ `smoke-test.yml` if deleted). Run `bun run script/check-workflows.ts` → green.
- [ ] Verify (`bun run script/check-workflows.ts` green; if `actionlint` available, lint the edited yml; grep no dangling `test-jetbrains`/`build-vscode`/`smoke-test` refs) + commit: `feat(release): strip vscode/jetbrains/docker/aur/homebrew CI; npm-only publish.yml + allowlist`.

## Task 2.2 — Release scripts: strip non-npm channels (both publish.ts) + vestigial refs

**Files:** `packages/opencode/script/publish.ts`; root `script/publish.ts`.
- [ ] **opencode/script/publish.ts:** remove the entire `if (!Script.preview) { … }` block (opens ~94, closes ~230) — docker/ghcr, AUR, Homebrew, and the SHA calc that only feeds them. KEEP the npm path (11-86: helpers + umbrella package build + per-platform publish). The umbrella `bin` can keep `northstar` (drop `kilocode` alias if you prefer, or keep as back-compat).
- [ ] **root script/publish.ts:** remove the vscode publish import + call (~123-126) and the JetBrains pin-PR (`createJetbrainsPinPr` call + fn, ~138-167). KEEP the `sdk` (117) + `plugin` (120) npm publishes if they're genuine npm packages we ship; if not shipping them, remove too (check `private` flag — only publish non-private). Report which you kept.
- [ ] Verify (`bun turbo typecheck` clean; `cd packages/opencode && bun run script/publish.ts --preview` or the dry-run path runs the npm branch with NO docker/aur/brew/vsce — capture output; if it needs a built dist, at minimum typecheck + grep-confirm the non-npm code is gone) + commit: `feat(release): publish scripts npm-only (drop docker/aur/homebrew/vscode/jetbrains fan-out)`.

## Task 2.3 — curl|bash install URL + README + config $schema

**Files:** `install` (24-25, 571); `README.md` (install section 39-132, badges 25-29, releases table 117-132); `packages/opencode/src/config/config.ts` ($schema literals 605,606,639,676,839) + `src/kilocode/skills/kilo-config.md`.
- [ ] `install`: help-example curl URLs (24-25) → `https://raw.githubusercontent.com/mrtcnbsk/northstar/main/install`; docs URL (571) `kilo.ai/docs` → `https://github.com/mrtcnbsk/northstar`.
- [ ] `README.md`: CLI install block → `npm install -g @ilura/northstar` + `curl -fsSL https://raw.githubusercontent.com/mrtcnbsk/northstar/main/install | bash` + pnpm/bun; DELETE the Homebrew/AUR/VSCode/JetBrains install blocks + the VS Code Marketplace / npm `@kilocode/cli` badges (npm badge → `@ilura/northstar`); the GitHub-releases table → `mrtcnbsk/northstar` (drop the `.vsix` note). Keep the Ilura banner + upstream attribution.
- [ ] `config.ts` `$schema` literals (5 sites) → decide: (a) `https://raw.githubusercontent.com/mrtcnbsk/northstar/main/config.schema.json` AND create/copy that schema file at repo root so the URL resolves (check if a generated config schema already exists to copy), OR (b) keep it simple if no schema is hosted. Pick the one that resolves; report. Update the skill doc reference too.
- [ ] Verify (`sh -n install`; `bun run script/check-forbidden-strings.ts` green — note kilo.ai hosting URLs are now being replaced, so fewer deferrals; markdown table padding guard if it runs on README) + commit: `feat(release): curl|bash raw-GitHub install + README npm/curl + northstar $schema`.

## Task 2.4 — Exit + review-prep
- [ ] `.changeset/` entry for the terminal-only release change.
- [ ] Full guard sweep: `check-workflows`, `check-forbidden-strings`, `check-opencode-annotations`, `check-kilo-generated-artifacts`, `check-md-table-padding` → all green. `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'` clean.
- [ ] Document the owner actions for actual release: reserve `@ilura/northstar` on npm; add repo secret `NPM_TOKEN`; first release may need an explicit `version` input or a seeded git tag (fetchLatest throws on empty releases + unpublished npm). Add to tracked-followups.
- [ ] Commit: `chore(release): EPIC 2 exit — changeset + owner-action notes (npm token, name reservation)`.

## Self-review
- npm-only publish.yml + scripts → 2.1/2.2 ✓ · curl|bash raw-GitHub + README → 2.3 ✓ · check-workflows allowlist synced → 2.1 ✓ · version git-based (already) + vestigial secrets dropped → 2.1/2.4 ✓.
- **Owner actions:** npm name reservation + `NPM_TOKEN` secret + first-release version seeding. **Left intact:** packages/kilo-vscode + kilo-jetbrains source (CI/release stripped only). **Deferred:** package deletion (later cleanup), the hosted config.schema.json if not created.
- Sequence: 2.1 (CI) → 2.2 (scripts) → 2.3 (docs/urls) → 2.4 (exit). The check-workflows allowlist sync (2.1) is the CI-break risk — verify green before proceeding.
