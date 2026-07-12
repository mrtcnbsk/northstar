# User-Visible Northstar Rebrand — Design

**Status:** Approved (2026-07-12)

**Goal:** Every product-owned surface that a user can see presents the product as **Northstar**, while all compatibility-sensitive Kilo/Kilo Code internals continue working unchanged.

## 1. Scope and invariant

The invariant is simple: product-owned copy says **Northstar**. This includes terminal output, interactive TUI copy, local Console pages, VS Code and JetBrains extension UI, notifications, onboarding, errors, command examples, help, tooltips, empty states, account labels, and product logos.

This is a display-layer rebrand, not a protocol or storage migration. A blind repository-wide replacement is explicitly out of scope.

## 2. User-visible surfaces

The rebrand covers:

- Northstar CLI help, descriptions, errors, warnings, prompts, daemon/console status, install/upgrade/uninstall output, and command examples.
- Terminal UI titles, command palette categories, tips, permission dialogs, provider/account dialogs, notifications, session resume hints, splash screens, and ASCII/pixel art.
- Builder, Chat, Cockpit, and the future Mission Control surface.
- Local web Console headings, descriptions, empty/error states, login/profile copy, navigation, and document titles.
- VS Code extension contributions, webview copy, localized strings, notifications, setup/migration UI, and Agent Manager user-facing text.
- JetBrains plugin actions, settings, dialogs, notifications, onboarding, and localized resources.
- User-facing package metadata and release/install copy where it identifies the product.

Developer-only comments, test descriptions, file names, and symbols do not need cosmetic renaming unless they are rendered or serialized into a user-visible surface.

## 3. Compatibility boundary

The following remain unchanged unless a separate migration is designed and approved:

- package/import names such as `@kilocode/*`;
- provider and auth identifiers such as `"kilo"`;
- `.kilo/`, `.kilocode/`, `kilo.json(c)`, and legacy migration paths;
- `KILO_*` environment variables and persisted storage keys;
- HTTP/SSE/WebSocket protocol fields, event names, database columns, telemetry keys, and SDK method names;
- Kilo Gateway/API domains and endpoints required by the existing backend;
- upstream copyright, license, NOTICE, attribution, and fork history;
- compatibility aliases accepted from older installations.

When a real technical path must be shown so the user can act on it, the UI shows the correct path verbatim—for example `.kilo/organization.jsonc`. It must not describe that path as a separate product brand.

Backend services may continue to use Kilo identifiers and domains. Product-owned labels around them use Northstar terminology: for example, **Northstar Account**, **Northstar Gateway**, or **Connect Northstar**. A required external URL may still target `app.kilo.ai`; the visible link label and surrounding explanation remain Northstar.

## 4. Copy and asset architecture

Each shipped UI boundary uses a small brand module or its existing localization layer as the source of product copy:

- CLI/TUI: canonical `Northstar` name, CLI command `northstar`, docs/repository URL, and user-facing gateway/account labels.
- Console: page titles and copy consume a local brand constant instead of repeating Kilo literals.
- VS Code: English source strings and every localized value present Northstar; internal command IDs and configuration keys remain stable.
- JetBrains: presentation strings/resources present Northstar; plugin IDs, package names, and compatibility settings remain stable.

Existing public constants such as `APP_NAME` and `APP_TITLE` are reused rather than duplicated. Brand modules contain display data only; they must not translate internal IDs before API calls.

The ASCII/pixel logo is replaced with artwork that reads **NORTHSTAR** in modern and fallback terminal variants. Rendering capability checks and the existing `KILO_UNICODE_LOGO` compatibility flag stay unchanged.

## 5. Mechanical migration rules

Every candidate occurrence is classified before editing:

1. **Visible product copy:** replace with Northstar.
2. **Visible command example:** replace the executable with `northstar`; retain a legacy command only when explicitly documenting compatibility.
3. **Visible backend/account label:** present Northstar while preserving the internal provider ID or URL.
4. **Operational path:** keep the real `.kilo`/legacy path.
5. **Internal contract or source-only name:** keep unchanged.
6. **Upstream attribution:** keep unchanged.

No mass replacement is allowed across package names, identifiers, URLs, or configuration keys.

## 6. Regression guard

A repository check maintains the boundary after this migration. It scans shipped user-facing source/resource locations for forbidden product-copy forms:

- `Kilo Code`
- `Kilo CLI`
- standalone `Kilo` when used as the product or actor
- obsolete user command examples beginning with `kilo `

The check uses a narrow, reviewed allowlist for compatibility identifiers, operational paths, backend URLs, developer-only sources, and attribution. New allowlist entries must include a reason. The guard runs in the relevant package tests and CI.

This check is not the sole proof. Render/help tests verify the major surfaces so a string hidden behind composition, localization, or a snapshot cannot bypass the invariant.

## 7. Data flow and behavior preservation

Only presentation values change:

```text
user sees Northstar copy
        │
        ▼
existing UI action / command
        │
        ▼
unchanged provider IDs, config paths, SDK calls, protocols, storage, backend URLs
```

No auth token, provider selection, model routing, session storage, org state, update path, or extension-to-server message changes shape as part of the rebrand.

## 8. Error handling

- Errors originating in product-owned code are rewritten as Northstar copy.
- Raw upstream/backend error payloads are not mutated when doing so would hide diagnostic meaning; the Northstar UI adds its own Northstar-labelled context around them.
- Links continue to target the working backend even when the visible label changes.
- Missing translation values fall back to English Northstar copy, never an old Kilo product label.

## 9. Testing and verification

Implementation follows TDD by surface:

1. Add a failing brand-boundary/forbidden-copy test.
2. Update one cohesive surface with minimal display-only changes.
3. Run its focused tests and render/help assertions.
4. Repeat for CLI/TUI, Console, VS Code, and JetBrains.
5. Run the repository guard, relevant lint/typechecks, package tests, and build checks.
6. Perform a final classified search showing that every remaining Kilo occurrence is an allowed internal/compatibility/attribution case.

Required acceptance evidence:

- `northstar --help` and representative failure paths contain no old product branding.
- TUI home, command palette, permission flow, account/provider flow, Builder, Cockpit, and session exit render Northstar.
- Console, VS Code, and JetBrains presentation resources contain Northstar across supported locales.
- The terminal logo reads NORTHSTAR in modern and fallback rendering modes.
- Existing provider/auth/config compatibility tests stay green.
- The forbidden-copy guard rejects a deliberately seeded visible `Kilo` string.

## 10. Delivery order

1. Inventory and guard.
2. CLI/TUI copy and logo.
3. Console copy.
4. VS Code copy/localization.
5. JetBrains copy/resources.
6. Cross-surface verification and release note.

After this rebrand is complete and verified, SP1 may add autonomous-engine copy using the Northstar brand from its first commit. SP2 then consumes the finalized SP1 contracts without reintroducing Kilo branding.
