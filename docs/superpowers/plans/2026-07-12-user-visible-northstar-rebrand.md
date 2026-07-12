# User-Visible Northstar Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner chose inline execution on `main`; do not create subagents or a separate worktree.

**Goal:** Make every product-owned user-visible surface say Northstar while preserving Kilo/Kilo Code compatibility identifiers, storage, provider IDs, URLs, protocols, and upstream attribution.

**Architecture:** Extend the existing forbidden-string CI check with a pure, path-aware display-brand scanner. Update one shipped UI boundary at a time, using local display constants/localization values while leaving internal IDs untouched. Each boundary adds a focused RED test before copy changes and passes its existing package checks before the next boundary starts.

**Tech Stack:** Bun, TypeScript, SolidJS/OpenTUI, VS Code extension resources, Kotlin/IntelliJ resource bundles, Turborepo, Bun test, Gradle/JUnit.

## Global Constraints

- Product-owned visible copy uses `Northstar`; visible executable examples use `northstar`.
- Keep `@kilocode/*`, provider/auth ID `"kilo"`, `.kilo/`, `.kilocode/`, `kilo.json(c)`, `KILO_*`, persisted keys, event/protocol names, backend URLs, and compatibility aliases unchanged.
- Keep upstream attribution and license/history text unchanged.
- A real operational path may display `.kilo/...`; it must not be presented as a product name.
- Do not rename symbols, action IDs, plugin IDs, translation keys, package paths, resource-bundle keys, or telemetry keys solely for cosmetics.
- User-facing changes require one changeset for `@ilura/northstar`; editor-package release notes stay in their existing changelog paths.
- Shared `packages/opencode/src` edits require `kilocode_change` annotations; Kilo-owned paths do not.
- Follow RED → GREEN → focused regression for every task.

---

### Task 1: Make the brand boundary executable in CI

**Files:**
- Create: `script/user-visible-brand.ts`
- Modify: `script/check-forbidden-strings.ts`
- Modify: `.github/workflows/check-forbidden-strings.yml`
- Create: `packages/opencode/test/kilocode/user-visible-brand.test.ts`

**Interfaces:**
- Produces: `BrandRule`, `BrandSource`, `BrandHit`, `VISIBLE_ROOTS`, `scanVisibleBrand(sources)`.
- Consumed by: the repository CLI guard and every later task's focused source fixture.

- [ ] **Step 1: Write the failing pure scanner tests.** Add tests that prove visible product copy and old executable examples fail, while internal IDs/paths/URLs remain allowed:

```ts
// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { scanVisibleBrand } from "../../../../script/user-visible-brand"

describe("user-visible Northstar brand boundary", () => {
  test("rejects old product copy and executable examples", () => {
    expect(
      scanVisibleBrand([
        { file: "packages/opencode/src/visible.ts", text: 'const a = "Ask Kilo"\nconst b = "kilo run"' },
      ]).map((hit) => hit.pattern),
    ).toEqual(["Kilo", "kilo run"])
  })

  test("keeps compatibility identifiers and backend URLs", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/opencode/src/internal.ts",
          text: 'const id = "kilo"\nconst dir = ".kilo"\nconst url = "https://app.kilo.ai"\nimport x from "@kilocode/sdk"',
        },
      ]),
    ).toEqual([])
  })

  test("reports line numbers", () => {
    expect(scanVisibleBrand([{ file: "x.ts", text: 'ok\nconst title = "Kilo CLI"' }])[0]).toMatchObject({
      file: "x.ts",
      line: 2,
      pattern: "Kilo CLI",
    })
  })
})
```

- [ ] **Step 2: Run RED.** From `packages/opencode`:

```bash
bun test test/kilocode/user-visible-brand.test.ts
```

Expected: fail because `script/user-visible-brand.ts` does not exist.

- [ ] **Step 3: Implement the pure scanner.** Use literal rules ordered most-specific-first and scan only string-bearing, shipped UI/resource roots. The module must not read the filesystem:

```ts
export type BrandSource = { file: string; text: string }
export type BrandHit = { file: string; line: number; pattern: string }
export type BrandRule = { pattern: RegExp; label: string }

export const VISIBLE_ROOTS = [
  "packages/opencode/src/cli/",
  "packages/opencode/src/kilocode/",
  "packages/kilo-console/src/",
  "packages/kilo-vscode/package.json",
  "packages/kilo-vscode/src/",
  "packages/kilo-vscode/webview-ui/",
  "packages/kilo-jetbrains/frontend/src/main/",
  "packages/kilo-jetbrains/src/main/resources/",
] as const

const rules: BrandRule[] = [
  { pattern: /Kilo Code/g, label: "Kilo Code" },
  { pattern: /Kilo CLI/g, label: "Kilo CLI" },
  { pattern: /\bkilo (?:run|serve|upgrade|auth|models|mcp|agent|github|debug|tui|daemon)\b/g, label: "kilo command" },
  { pattern: /\bKilo\b/g, label: "Kilo" },
]

function ignored(line: string, start: number, end: number) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("#")) {
    return true
  }
  if (/^(?:import|export .* from)\b/.test(trimmed)) return true
  if (line.slice(Math.max(0, start - 1), start) === "." || line.slice(end, end + 1) === ".") return true
  if (line.includes("[Kilo New]")) return true
  return false
}

export function scanVisibleBrand(sources: BrandSource[]): BrandHit[] {
  const hits: (BrandHit & { start: number; end: number })[] = []
  for (const source of sources) {
    const lines = source.text.split("\n")
    for (const [index, line] of lines.entries()) {
      const found: { start: number; end: number; pattern: string }[] = []
      for (const rule of rules) {
        rule.pattern.lastIndex = 0
        for (const match of line.matchAll(rule.pattern)) {
          const start = match.index
          const end = start + match[0].length
          if (ignored(line, start, end)) continue
          found.push({ start, end, pattern: match[0] })
        }
      }
      found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
      const accepted: typeof found = []
      for (const item of found) {
        if (accepted.some((hit) => item.start >= hit.start && item.end <= hit.end)) continue
        accepted.push(item)
        hits.push({ file: source.file, line: index + 1, pattern: item.pattern, start: item.start, end: item.end })
      }
    }
  }
  return hits
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.start - b.start)
    .map(({ file, line, pattern }) => ({ file, line, pattern }))
}
```

The implementation must expose small predicates (`isImport`, `isCompat`, `isComment`) so tests can pin each exclusion. Do not allow whole directories that also render UI.

- [ ] **Step 4: Run GREEN.** Run the focused test and confirm all scanner cases pass.

- [ ] **Step 5: Wire the scanner into the existing guard.** `script/check-forbidden-strings.ts` already enumerates tracked text files. Pass sources under `VISIBLE_ROOTS` to `scanVisibleBrand`, merge its hits into the existing output, and retain the current upstream-forbidden checks unchanged.

- [ ] **Step 6: Point the workflow at this fork.** Change the workflow job condition to:

```yaml
if: github.repository == 'mrtcnbsk/northstar'
```

- [ ] **Step 7: Prove the repository is RED before rebranding.** Run:

```bash
bun run script/check-forbidden-strings.ts
```

Expected: fail with current visible Kilo copy in CLI/TUI, Console, VS Code, and JetBrains paths.

- [ ] **Step 8: Commit the failing guard foundation.** The focused scanner tests must pass; the repository-wide guard is intentionally RED until Tasks 2–5.

```bash
git add script/user-visible-brand.ts script/check-forbidden-strings.ts .github/workflows/check-forbidden-strings.yml packages/opencode/test/kilocode/user-visible-brand.test.ts
git commit -m "test(brand): enforce user-visible Northstar boundary"
```

---

### Task 2: Rebrand CLI and terminal UI without changing runtime contracts

**Files:**
- Modify: `packages/opencode/test/kilocode/command-branding.test.ts`
- Create: `packages/opencode/test/kilocode/user-visible-cli-brand.test.ts`
- Modify: `packages/opencode/src/index.ts`
- Modify: `packages/opencode/src/cli/error.ts`
- Modify: `packages/opencode/src/cli/cmd/upgrade.ts`
- Modify: `packages/opencode/src/cli/cmd/debug/index.ts`
- Modify: `packages/opencode/src/cli/cmd/mcp.ts`
- Modify: `packages/opencode/src/cli/cmd/pr.ts`
- Modify: `packages/opencode/src/cli/cmd/web.ts`
- Modify: `packages/opencode/src/cli/cmd/run.ts`
- Modify: `packages/opencode/src/cli/cmd/serve.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/{attention,attach,thread}.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- Modify: `packages/opencode/src/cli/cmd/run/permission.shared.ts`
- Modify: `packages/opencode/src/cli/cmd/run/footer.permission.tsx`
- Modify: `packages/opencode/src/cli/cmd/run/splash.ts`
- Modify: `packages/opencode/src/kilocode/cli/agent-requirements.ts`
- Modify: `packages/opencode/src/kilocode/cli/cmd/{console,daemon,profile}.ts`
- Modify: `packages/opencode/src/kilocode/cli/cmd/tui/app.tsx`
- Modify: `packages/opencode/src/kilocode/components/{tips,kilo-error-display,dialog-indexing}.tsx`
- Modify: `packages/opencode/src/kilocode/cli/cmd/tui/feature-plugins/home/tips.ts`
- Modify: `packages/opencode/src/kilocode/cli/logo.ts`
- Modify: affected focused tests and snapshots adjacent to these files.

**Interfaces:**
- Consumes: `APP_NAME="Northstar"`, `APP_TITLE="Northstar"`, binary name `northstar`.
- Preserves: provider IDs, config paths, daemon protocol, gateway URLs, `KILO_UNICODE_LOGO`.

- [ ] **Step 1: Update tests to describe Northstar.** Change `command-branding.test.ts` to reject `opencode` and `kilo` executable examples and require `northstar`; add a source/render test covering command palette category, tips, permissions, cost alert, error/login hint, daemon/console output, and both logo variants.

- [ ] **Step 2: Run RED.** From `packages/opencode`, run the two focused tests. Confirm failures list current visible Kilo copy rather than syntax/setup errors.

- [ ] **Step 3: Apply display-only copy changes.** Use these mappings only in visible strings:

```text
Kilo Code / Kilo CLI / standalone product Kilo -> Northstar
kilo run|serve|upgrade|auth|models|mcp|agent|github|debug|tui|daemon -> northstar ...
Kilo Console -> Northstar Console
Kilo Account -> Northstar Account
Kilo Gateway (visible label only) -> Northstar Gateway
```

Keep `.kilo`, `kilo.json(c)`, internal URL/provider strings, action names, comments, and identifiers. Set `yargs(...).scriptName("northstar")`. Change `category: "Kilo"` to `"Northstar"` and direct-run permission copy to “until Northstar is restarted” / “Tell Northstar what to do differently.”

- [ ] **Step 4: Replace terminal art.** Update modern/fallback `tui`, `plain`, and `exit` arrays so the rendered word is NORTHSTAR. Keep selection logic and `KILO_UNICODE_LOGO` unchanged; pin line counts and `northstar -s` in tests.

- [ ] **Step 5: Run focused GREEN and CLI regression.** Run:

```bash
bun test test/kilocode/command-branding.test.ts test/kilocode/user-visible-cli-brand.test.ts test/cli/run/permission.shared.test.ts
bun run typecheck
```

- [ ] **Step 6: Run the global guard.** It must still fail, but no hit may come from `packages/opencode/src` except explicitly accepted operational/internal cases.

- [ ] **Step 7: Commit.**

```bash
git add packages/opencode/src packages/opencode/test
git commit -m "feat(cli): finish user-visible Northstar rebrand"
```

---

### Task 3: Rebrand the local Console

**Files:**
- Create: `packages/kilo-console/src/brand.ts`
- Create: `packages/kilo-console/src/brand.test.ts`
- Modify: `packages/kilo-console/src/App.tsx`
- Modify: `packages/kilo-console/src/index.tsx`
- Modify: `packages/kilo-console/src/client.ts`
- Modify: `packages/kilo-console/src/context/ConfigProvider.tsx`
- Modify: `packages/kilo-console/src/components/{LoadingLogo,LoadingScreen}.tsx`
- Modify: `packages/kilo-console/src/components/app-header/AppHeader.tsx`
- Modify: `packages/kilo-console/src/routes/profile/{LoginRoute,ProfileRoute}.tsx`
- Modify: `packages/kilo-console/src/routes/projects/{ProjectsRoute,ProjectConsoleRoute}.tsx`
- Modify: `packages/kilo-console/src/routes/config/{AgentsRoute,FormattersRoute,IndexingRoute,ModelsRoute,ServersRoute}.tsx`
- Modify: adjacent Console tests whose assertions are user-visible copy.

**Interfaces:**
- Produces: `BRAND_NAME`, `CONSOLE_NAME`, `CLI_NAME`, `ACCOUNT_NAME`, `GATEWAY_NAME` display constants.
- Preserves: `/kilo/login`, `kilo.console.*` localStorage keys, SDK `kilo.*`, provider ID, backend URLs, default credentials, theme IDs, CSS classes, asset paths.

- [ ] **Step 1: Write RED tests.** `brand.test.ts` must scan the listed render sources and assert no visible old product copy, while explicitly asserting `/kilo/login`, `kilo.console.*`, and `https://app.kilo.ai` remain unchanged.

- [ ] **Step 2: Run RED.** From `packages/kilo-console`:

```bash
bun test src/brand.test.ts
```

- [ ] **Step 3: Add display constants.** Create:

```ts
export const BRAND_NAME = "Northstar"
export const CONSOLE_NAME = "Northstar Console"
export const CLI_NAME = "Northstar CLI"
export const ACCOUNT_NAME = "Northstar Account"
export const GATEWAY_NAME = "Northstar Gateway"
```

- [ ] **Step 4: Replace visible JSX, aria labels, defaults, and operation labels.** Use the constants where copy is composed; change terminal title defaults from `Kilo N` to `Northstar N` and spawned visible command/title to Northstar while leaving the backend executable path/SDK contract unchanged.

- [ ] **Step 5: Run GREEN and Console checks.**

```bash
bun test
bun run typecheck
```

- [ ] **Step 6: Commit.**

```bash
git add packages/kilo-console
git commit -m "feat(console): present Northstar across the local UI"
```

---

### Task 4: Rebrand VS Code metadata, webview, extension messages, and locales

**Files:**
- Create: `packages/kilo-vscode/tests/unit/user-visible-brand.test.ts`
- Modify: `packages/kilo-vscode/package.json`
- Modify: user-visible strings in `packages/kilo-vscode/src/**/*.ts`
- Modify: user-visible strings in `packages/kilo-vscode/webview-ui/**/*.tsx`
- Modify: values (not keys) in:
  - `packages/kilo-vscode/webview-ui/src/i18n/*.ts`
  - `packages/kilo-vscode/src/services/cli-backend/i18n/*.ts`
  - `packages/kilo-vscode/src/services/i18n/autocomplete/*.ts`
- Modify: affected extension/webview tests and snapshots.

**Interfaces:**
- User-visible values: Northstar.
- Preserved contracts: package name `kilo-code`, command/view IDs `kilo-code.*`, `KILO_*`, provider ID, `.kilo`, server binary path/protocol, translation keys including names such as `aboutKiloCode`, theme IDs, DOM events, storage, telemetry.

- [ ] **Step 1: Write a RED package scanner test.** Read `package.json`, the three locale families, and product-owned extension/webview render sources. Assert no visible `Kilo Code`, `Kilo CLI`, standalone product `Kilo`, or old executable examples. Assert representative internal IDs remain exactly unchanged.

- [ ] **Step 2: Run RED.** From `packages/kilo-vscode`:

```bash
bun run test:unit -- --grep "user-visible Northstar brand"
```

- [ ] **Step 3: Update package contribution labels and English source copy.** Change display names, descriptions, settings/about headings, notifications, onboarding, migration UI, Agent Manager copy, autocomplete labels, and backend failure context. Do not rename JSON keys or command IDs.

- [ ] **Step 4: Update every locale value.** Replace the product token inside translated values with `Northstar` (proper noun, untranslated). Preserve key names and interpolation placeholders byte-for-byte. Add a test that compares placeholder sets before/after for each locale entry.

- [ ] **Step 5: Run format and focused GREEN.**

```bash
bun run format
bun run test:unit -- --grep "user-visible Northstar brand"
bun run check-types:extension
bun run check-types:webview
bun run lint
```

- [ ] **Step 6: Run the global guard.** No remaining hit may come from VS Code shipped UI/resource paths except compatibility identifiers recognized by the scanner.

- [ ] **Step 7: Commit.**

```bash
git add packages/kilo-vscode
git commit -m "feat(vscode): present Northstar across extension UI"
```

---

### Task 5: Rebrand JetBrains presentation resources

**Files:**
- Create: `packages/kilo-jetbrains/frontend/src/test/kotlin/ai/kilocode/client/UserVisibleBrandTest.kt`
- Modify: `packages/kilo-jetbrains/src/main/resources/META-INF/plugin.xml`
- Modify: `packages/kilo-jetbrains/frontend/src/main/resources/kilo.jetbrains.frontend.xml`
- Modify: values (not keys) in `packages/kilo-jetbrains/frontend/src/main/resources/messages/KiloBundle*.properties`
- Modify: hard-coded visible strings in `packages/kilo-jetbrains/frontend/src/main/kotlin/ai/kilocode/client/**/*.kt`
- Modify: affected JetBrains UI/resource tests.

**Interfaces:**
- User-visible bundle/plugin values: Northstar.
- Preserved contracts: Kotlin packages/classes, `Kilo.*` action IDs, `KiloBundle` keys/class, module/plugin IDs, `kilo.*` properties, backend executable/config/protocol, icon resource paths unless the asset itself visibly contains old branding.

- [ ] **Step 1: Write RED resource test.** Enumerate plugin XML and every `KiloBundle*.properties` file. Parse property values (not keys) and reject old product copy. Assert keys such as `action.Kilo.*` and IDs such as `Kilo.NewSession` remain present.

- [ ] **Step 2: Run RED.** From `packages/kilo-jetbrains`:

```bash
./gradlew :frontend:test --tests '*UserVisibleBrandTest'
```

- [ ] **Step 3: Update plugin metadata and resource values.** Replace display name, tool window title, settings labels, actions, notifications, account/login copy, descriptions, and accessibility labels. Replace only values; preserve action/resource keys.

- [ ] **Step 4: Update hard-coded runtime presentation strings.** Change visible dialog/log notification text that can reach users. Keep internal logger messages and symbol comments unless rendered.

- [ ] **Step 5: Run GREEN and JetBrains checks.**

```bash
./gradlew :frontend:test --tests '*UserVisibleBrandTest'
./gradlew typecheck
./gradlew test
```

- [ ] **Step 6: Commit.**

```bash
git add packages/kilo-jetbrains
git commit -m "feat(jetbrains): present Northstar across plugin UI"
```

---

### Task 6: Close the guard, release note, and cross-surface verification

**Files:**
- Modify: `script/user-visible-brand.ts` only for narrowly justified false-positive predicates discovered during Tasks 2–5.
- Create: `.changeset/bright-stars-align.md`
- Modify: `docs/superpowers/tracked-followups.md` to record the completed rebrand boundary and retained compatibility names.

**Interfaces:**
- Produces: a green repository-wide user-visible brand invariant.

- [ ] **Step 1: Run the guard and review every remaining hit.**

```bash
bun run script/check-forbidden-strings.ts
```

Expected: exit 0. Do not add broad directory allows. Every new predicate must be backed by a focused test proving the occurrence is an internal contract/path/URL/key.

- [ ] **Step 2: Add the changeset.** Target `@ilura/northstar` with a patch release and user-oriented text:

```markdown
---
"@ilura/northstar": patch
---

Present the Northstar brand consistently across CLI, terminal, Console, VS Code, and JetBrains interfaces while preserving existing configuration and provider compatibility.
```

- [ ] **Step 3: Run focused package verification.**

```bash
cd packages/opencode && bun test test/kilocode/command-branding.test.ts test/kilocode/user-visible-brand.test.ts test/kilocode/user-visible-cli-brand.test.ts test/cli/run/permission.shared.test.ts
cd packages/kilo-console && bun test && bun run typecheck
cd packages/kilo-vscode && bun run format && bun run typecheck && bun run lint && bun run test:unit
cd packages/kilo-jetbrains && ./gradlew typecheck && ./gradlew test
```

- [ ] **Step 4: Run root guards.**

```bash
bun run lint
bun run typecheck
bun run script/check-opencode-annotations.ts
bun run script/check-md-table-padding.ts
bun run script/extract-source-links.ts
```

If source-link extraction changes `packages/kilo-docs/source-links.md`, include it. Do not claim completion if any command fails; record the exact pre-existing or introduced failure.

- [ ] **Step 5: Manually inspect representative rendered/help surfaces.** Capture fresh evidence for:
  - `northstar --help` and `northstar run --help`;
  - TUI home/logo, command palette, permission reject/always copy, account/provider dialog, Builder, and Cockpit;
  - Console header/login/profile/projects/config;
  - VS Code sidebar/settings/about/Agent Manager;
  - JetBrains tool window/settings/profile/actions.

- [ ] **Step 6: Commit closure.**

```bash
git add .changeset docs/superpowers/tracked-followups.md script packages/kilo-docs/source-links.md
git commit -m "chore(brand): enforce Northstar presentation invariant"
```

- [ ] **Step 7: Push `main` only after fresh verification evidence.**

```bash
git status --short --branch
git log --oneline -7
git push --no-verify origin main
```

The `--no-verify` flag bypasses the known locale-sensitive pre-push JetBrains hook only after the explicit JetBrains/root checks above have passed.
