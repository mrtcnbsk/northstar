# EPIC 5 — Provider/Model Authoring (BYOK + local)

> REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Let users add a BYOK key or a **local/openai-compatible provider** (Ollama / LM Studio / generic baseURL) from the TUI, list them via `northstar models`, dedicate a model to an agent, and get a visible warning when a local model lacks context/tool-call support. Reuse the anaconda-desktop local-provider substrate.

**Branch:** `feat/provider-authoring` (off main `0c36f37008`).

**Acceptance (exit):** a local provider defined (preset + baseURL, key → GLOBAL `auth.json`) resolves in `Provider.list()` and appears in `northstar models`; a model can be dedicated to an agent (`model: providerID/modelID`); a local model with `limit.context===0` or `toolcall===false` surfaces a visible warning (and compaction stays off); the `{env:}` security invariant (project config rejects env refs) is UNCHANGED.

**Security invariant (PRESERVE, do NOT touch):** `config/variable.ts` `substitute()` throws on `{env:}` in untrusted/project config; BYOK/local keys go to the GLOBAL `auth.json` (0600), never project config. Keep `trusted` defaulting false for project config.

**Conventions:** `bun` at `~/.bun/bin`. Test from `packages/opencode/`. Typecheck `bun turbo typecheck --filter='!@kilocode/kilo-jetbrains'`. NEVER stage `bun.lock`. `// kilocode_change` on shared-file edits (follow the kilocode override seam for the TUI dialog). Push `--no-verify`.

---

## Task 5.1 — Command parity (cosmetic rebrand of the provider CLI)
**Files:** `packages/opencode/src/cli/cmd/providers.ts` (~L306, L458, L467, L478).
- [ ] Rename user-facing cosmetic strings: L306 `"kilo auth provider"` → northstar phrasing; L458/L467 `kilo.json` → `northstar.jsonc` (the config file 5.1 authors write into); L478 `https://kilo.ai/docs/ai-providers/cloudflare` → the repo README (or a de-branded phrasing). Keep `// kilocode_change` markers.
- [ ] **LEAVE (backend):** the `kilo` gateway provider (provider.ts `kilo` loader, `KILO_BUNDLED_PROVIDERS`, `ProviderID "kilo"`) + the kilo.ai `HTTP-Referer`/`X-Title` service headers (live Kilo Gateway — renaming breaks routing/attribution). Do NOT re-wire `account`/`console` (orthogonal to model authoring; stays commented out).
- [ ] Verify (`northstar auth --help` / `northstar models` run; check-forbidden-strings + annotations green; the provider cmd tests pass) + commit: `feat(provider): rebrand provider-CLI copy (northstar.jsonc/repo docs); Kilo Gateway backend left intact`.

## Task 5.2 — Generic local/openai-compatible provider (registration + TUI add dialog)
**Files:** `packages/opencode/src/provider/models.ts` (`get()`/`addApertis` pattern); a new/extended local-provider registration; `packages/opencode/src/kilocode/cli/cmd/tui/component/dialog-provider.tsx` (the kilocode override seam) + a new `LocalProviderMethod` component (model on `kilocode/anaconda-desktop/tui/setup.tsx`); reuse `kilocode/anaconda-desktop/domain.ts` (encodeMetadata/normalizeLoopbackEndpoint) + `model-cache.ts` (openai-compatible `/models` fetch).
- [ ] **Registration (the testable core):** generalize the anaconda-desktop pattern so a GLOBAL auth-store entry with `metadata:{ baseURL, preset }` (type `"api"`, key `"local"` or a real key) is registered in `provider/models.ts get()` as an openai-compatible provider (`npm:"@ai-sdk/openai-compatible"`, `api:baseURL`), with its models discovered via the model-cache openai-compatible `/models` fetch (like `apertis`/`aperture`). So a local provider added to `auth.json` RESOLVES in `Provider.list()` + `northstar models`.
- [ ] **LOCAL_PRESETS** map: `ollama → http://localhost:11434/v1`, `lmstudio → http://localhost:1234/v1`, `openai-compatible → <user-entered baseURL>`.
- [ ] **TUI add-local branch:** in the kilocode dialog-provider override, add an "Add a local provider" option → `dialog.replace(<LocalProviderMethod>)`: DialogSelect preset → DialogPrompt baseURL (validate with a relaxed `normalizeLoopbackEndpoint`/endpoint check) → optional DialogPrompt key. On submit: `sdk.client.auth.set({ providerID, auth: { type: "api", key: key || "local", metadata: { baseURL, preset } } })` (GLOBAL — never project config).
- [ ] **TDD (unit the core, not the TUI render):** a test — write an auth-store entry with `{baseURL, preset}` metadata for a fake local provider, assert `Provider.list()`/the models get() resolves it as an openai-compatible provider with ≥1 model (mock the `/models` fetch); assert the key landed in the GLOBAL auth store (0600), NOT project config; assert the preset baseURLs resolve. (The TUI component render is manual-verifiable; unit the registration + the LocalProviderMethod's submit handler logic if extractable.)
- [ ] Verify (provider/model tests green; typecheck; TUI compiles) + commit: `feat(provider): generic local/openai-compatible provider (presets + baseURL) via global auth store + TUI add dialog`.

## Task 5.3 — Local-model validation (visible warning + catalog fallback)
**Files:** `packages/opencode/src/provider/provider.ts` (dynamic-model merge ~L1380/L1414); `packages/opencode/src/provider/model-cache.ts` (`aperture()` ~L78-90 blind 128k default); the warning surface (generalize `kilocode/anaconda-desktop/domain.ts warning(toolcall)` + `tui/model.ts` "Limited tool support" view); test.
- [ ] **Fix the masking default:** `model-cache.ts aperture()` hardcodes `limit.context=128000` / `tool_call=true` for discovered models with no metadata — this MASKS the unknown-capability case. Change so an unknown-context/unknown-toolcall local model is flagged as UNVERIFIED (e.g. `context: 0` when genuinely unknown, or a `verified:false` marker) so the compaction-off + warning path fires. Keep the models.dev catalog fallback (`?? existingModel?...` merge) for models that ARE in the catalog.
- [ ] **Bridge the naming:** catalog `tool_call` (snake, bool) vs runtime `toolcall` (camel) vs anaconda 3-state `['supported','unsupported','unknown']` — a single capability check that treats absent/unknown as "unverified".
- [ ] **Visible warning:** generalize the anaconda `warning(toolcall)` + "Limited tool support" pattern so ANY resolved local model with `limit.context===0` (unknown) OR `toolcall` not-supported surfaces a visible warning in the provider/model dialog and/or `model-status`. Compaction stays off (overflow.ts context===0 already does this — do NOT change that logic).
- [ ] **TDD:** a test — a local model with unknown context/toolcall → the capability check returns "unverified" + a warning string is produced + `overflow.isOverflow` stays false (compaction off); a model WITH catalog metadata → no warning, real limits used.
- [ ] Verify (provider tests green; typecheck) + commit: `feat(provider): local-model validation — flag unverified context/tool-call + visible warning (compaction stays off)`.

## Task 5.4 — Exit test + review-prep
- [ ] **Exit test:** (a) a local provider (auth-store `{baseURL, preset}`, mocked `/models`) resolves in `Provider.list()` + would appear in `northstar models`; (b) that provider/model can be set as an agent's `model:` (parseModel resolves it); (c) a no-context/no-toolcall local model produces the warning + `overflow` keeps compaction off; (d) the `{env:}` invariant test still holds (project config rejects env refs — a regression guard).
- [ ] Verify (exit + provider/config/overflow suites green; typecheck; guards; `.changeset/`) + commit: `test(provider): EPIC 5 exit — local provider resolves + agent-dedicatable + unverified-model warning`.

## Self-review
- command parity → 5.1 ✓ · BYOK+local dialog → 5.2 ✓ · local validation → 5.3 ✓ · exit (add→list→dedicate + warning) → 5.4 ✓.
- **Deferred/left:** the Kilo Gateway provider + service headers (backend); `account`/`console` (orthogonal); the actual visual TUI render proof (no e2e harness — manual, like kilo-console). **Reuse:** ~90% (auth.set global write, DialogSelect/DialogPrompt stack, anaconda warning/metadata/loopback helpers, overflow context-0, catalog merge, model-cache openai-compatible fetch).
- **Risk:** the {env:} security invariant must stay untouched (5.2 writes to global auth only). Sequence 5.1 → 5.2 → 5.3 → 5.4.
