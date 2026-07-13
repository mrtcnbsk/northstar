# Northstar Workspace, Onboarding, and Multi-Organization Design

**Date:** 2026-07-13
**Status:** Approved for implementation
**Scope:** Northstar TUI, project-local organization management, knowledge import, Chat handoff, and Mission Control startup

## 1. Goal

Make Northstar open as one coherent organization workspace instead of a branded legacy home screen.

On a workspace with no organization, Northstar opens a guided Setup flow. The user creates an organization, departments, agents, a fixed three-layer hierarchy, and managed knowledge. On a workspace with one or more organizations, Northstar opens Mission Control for the active organization. The user can switch organizations, Chat, Setup, and Mission without leaving the persistent Northstar shell.

After Setup, the user gives the organization a task in Chat, approves the generated plan and any genuine human decisions, then watches the autonomous run reach completion in Mission Control.

All user-visible text is English-only. This phase does not add localization infrastructure, locale detection, translation keys, or a language selector.

## 2. Approved product decisions

- Use one persistent Northstar workspace shell with `Setup`, `Chat`, and `Mission` sections.
- Use a compact persistent header, clickable section labels, and leader shortcuts.
- `Ctrl+X M` opens Mission from anywhere; `Ctrl+X C` opens Chat; `Ctrl+X S` opens Setup.
- `Ctrl+X O` opens the project-local organization selector.
- A missing organization opens Setup. A valid organization opens Mission.
- An invalid organization opens Setup in a repair state.
- Organizations are named and project-local, not global reusable profiles.
- The runtime hierarchy remains three levels deep: Executive, Department Leads, and Specialists.
- Layer labels and missions are editable, but delegation depth remains unchanged.
- Knowledge is organization-owned, with a shared area and one isolated subdirectory per department.
- Imported knowledge files are copied into Northstar-managed storage. They are snapshots, not live links.
- The user explicitly re-imports a source to refresh a managed copy.
- Existing `.kilo` storage and APIs are preserved or adapted behind Northstar-owned boundaries where possible.
- Existing user-visible Kilo branding must not appear in the new workspace.

## 3. User experience

### 3.1 Persistent workspace shell

The shell is visible on Setup, Chat, session, and Mission surfaces:

```text
NORTHSTAR  Product Studio                 Setup   Chat   ● Mission
───────────────────────────────────────────────────────────────
Current section content
───────────────────────────────────────────────────────────────
ctrl+x o Organization  ctrl+x s Setup  ctrl+x c Chat  ctrl+x m Mission
```

The active organization name is interactive. Clicking it or pressing `Ctrl+X O` opens a selector containing every organization in the current workspace, its validation state, and active/paused run count. The selector always includes `+ New organization`, which starts Setup with a clean staged draft. Opening Setup for the active organization enters edit mode instead.

Section labels are mouse-selectable. Keyboard shortcuts are leader sequences so they do not steal normal Chat input, autocomplete, or agent controls.

Compatibility commands remain available:

- `/mission` and `/cockpit` open Mission.
- `/builder` and `/org-builder` open Setup in edit mode.
- Existing template commands continue to work for legacy projects.

### 3.2 Startup state machine

Northstar starts on a small bootstrap route that loads the project-local organization registry before selecting the visible section.

```text
registry absent + no legacy organization  -> Setup / Create organization
registry absent + valid legacy organization -> register Legacy organization -> Mission
registry has active valid organization     -> Mission
registry has no active organization         -> organization selector or Setup
active organization invalid                -> Setup / Repair required
registry unreadable                         -> Setup / Registry repair, never an empty Mission
```

If the active organization has an active or paused run, Mission selects the newest such run. Otherwise Mission shows the organization summary, recent runs, and a prominent `Start a mission` action.

### 3.3 Organization switching

Switching organizations updates the whole workspace boundary:

- active agents and selected CEO;
- organization configuration and validation;
- shared and department knowledge;
- Chat sessions associated with the organization;
- run list, current run, memory, lessons, and Mission panels.

Switching does not stop background autonomous runs. The selector shows run state so the user can return to an active organization. If Setup has unsaved edits, switching asks the user to discard them or remain on the current organization.

After a switch, Northstar disposes the project instance cache, bootstraps the selected organization context, and opens Mission. It never renders data from the previously active organization while the new context is loading.

## 4. Project-local storage

### 4.1 Registry

The workspace registry lives at `.kilo/organizations.json` and uses a versioned schema:

```json
{
  "version": 1,
  "active": "product-studio",
  "organizations": [
    {
      "id": "product-studio",
      "name": "Product Studio",
      "layout": "managed",
      "root": "organizations/product-studio"
    }
  ]
}
```

Organization IDs are stable slugs. Display names may change without moving directories. Registry writes use a temporary file followed by rename.

### 4.2 Managed organization layout

```text
.kilo/organizations/<organization-id>/
├── organization.jsonc
├── agents/
├── knowledge/
│   ├── manifest.json
│   ├── shared/
│   └── departments/
│       └── <department-id>/
├── runs/
├── memory/
├── lessons.md
└── rag/
```

All organization-owned runtime paths resolve through one Northstar-owned `OrgWorkspace` boundary. Organization code receives an organization context containing the workspace directory, organization ID, layout, and resolved root. New code must not reconstruct organization paths independently.

HTTP and SDK operations that read or mutate organization state carry an optional organization ID. Absence means the active organization. Legacy callers continue to resolve the legacy layout.

### 4.3 Legacy compatibility

When `.kilo/organization.jsonc` exists and no registry exists, Northstar registers a `Legacy organization` entry with `layout: "legacy"`. Its files remain in place:

```text
.kilo/organization.jsonc
.kilo/agent/
.kilo/org/runs/
.kilo/org/memory/
```

No automatic move, rename, symlink, or destructive migration occurs. The resolver maps legacy operations to these existing paths. This is required for Windows compatibility and for existing CLI/template workflows.

## 5. Setup flow

Setup is a guided, resumable five-step flow. New organizations are authored under `.kilo/organizations/.staging/<organization-id>/` and become visible only after final validation and atomic publication.

### 5.1 Organization

The user provides:

- organization name;
- optional starter template;
- editable names and missions for the three fixed layers.

Default layer names are `Executive`, `Department Leads`, and `Specialists`. Runtime roles remain CEO, chief, and worker regardless of their display labels.

### 5.2 Departments

The user creates departments with:

- stable department ID derived from the name;
- display name;
- department mission;
- assigned Department Lead;
- assigned Specialists.

Departments can be added, reordered, renamed, and removed while still in the draft. Removing a department requires reassignment or removal of its agents and knowledge.

### 5.3 Agents

The agent editor captures:

- name and display name;
- fixed layer and department;
- role;
- `Do` rules;
- `Don't` rules;
- model;
- existing permission controls;
- allowed subordinates derived from the hierarchy.

The editor serializes role and behavior into stable Markdown sections:

```markdown
# Role

...

# Do

- ...

# Don't

- ...
```

Model, mode, permissions, and subordinates remain frontmatter fields compatible with the existing agent loader. The Setup UI owns the structured draft; the runtime continues to consume standard agent Markdown.

### 5.4 Knowledge

The knowledge step has two destinations:

- `Shared knowledge`, readable by every department;
- one knowledge collection per department, readable only by that department's chief and specialists.

The initial file picker selects files from the current workspace. Supporting arbitrary external filesystem paths is out of scope for this phase because it requires a separate trust and permission boundary.

`Import and read` performs one operation from the user's perspective:

1. copy each selected file into the staging organization's managed knowledge directory;
2. compute a content hash and record source-relative path, managed path, size, and import time in `manifest.json`;
3. reject path traversal, unsupported binary input, unsafe names, and duplicate destination collisions;
4. extract supported text and build the organization-scoped local search index;
5. when an embedding provider is configured, also update the semantic vector index;
6. report each file as imported, indexed, unchanged, or failed.

Imported files never remain as references to the source. Re-import replaces the managed copy only after the new copy and index operation succeed.

The local text index requires no external model or provider, so first-run `Import and read` remains one action. Semantic vector indexing is an optional enhancement: if no embedder is configured or the vector update fails, scoped local search and direct managed-file reads remain available. Setup retains copied staging data and offers retry or removal when required text extraction fails. Finish remains disabled only while selected files have required import/text-index work in a failed or pending state.

### 5.5 Review and publish

Review shows:

- organization and layer missions;
- department hierarchy;
- agent roles, models, and permission summary;
- knowledge counts by shared/department scope;
- budget, loop, and pipeline defaults;
- validation errors and warnings.

Finish performs server-side validation against the staged organization and agent roster, then atomically renames the staged directory into its managed location and adds it to the registry. Failed validation leaves the current active organization unchanged.

On success, the organization becomes active and Northstar opens Mission.

## 6. Chat-to-Mission data flow

### 6.1 Chat binding

Every Northstar Chat session created under the workspace shell records an optional organization ID. Legacy sessions without an ID remain visible only under the Legacy organization or the generic compatibility surface.

Opening Chat selects the organization's most recent session. If none exists, it opens a new Chat composer preselected to the organization's CEO agent. The user does not need to discover or manually select the CEO.

### 6.2 Starting a mission

The Mission empty state and Chat both start a task through the same command path:

1. create or reuse the active organization's CEO Chat session;
2. submit the user's brief to the CEO;
3. call the existing `org_start`, `org_advance`, and `org_plan` protocol;
4. present the editable plan approval in Chat and Mission;
5. on approval, attach the existing autonomous driver;
6. navigate to Mission and select the run.

The run snapshots its organization ID. Later organization switches cannot change which configuration, agents, knowledge, memory, or paths the run uses.

### 6.3 Knowledge delivery

Stage prompts identify the active organization and department. They expose:

- shared managed knowledge;
- only the current department's managed knowledge;
- prior run deliverables already allowed by the pipeline.

Knowledge retrieval extends the existing organization RAG/search boundary instead of creating a second unrelated search tool. It uses semantic vectors when available and the local text index as the guaranteed fallback. Queries are filtered by organization ID and department scope before results reach an agent. A department cannot retrieve another department's private knowledge.

### 6.4 Decisions and completion

Plan approval, escalation, steering, and final-gate actions continue to use the existing guarded organization endpoints and Mission cards. Chat and Mission render the same underlying run state.

When a run becomes `completed`, Mission shows a completion state with final deliverables, cost, elapsed time, and a return-to-Chat action. Switching to Chat never detaches or stops the autonomous driver.

## 7. Component boundaries

### `OrgWorkspace`

Owns registry parsing, active organization selection, legacy discovery, path resolution, and atomic registry writes. It performs no TUI rendering.

### `OrganizationContext`

Carries the resolved organization identity through server handlers, organization tools, run creation, Chat sessions, and Mission requests. It prevents callers from reading state by workspace path alone.

### `WorkspaceShell`

Renders the compact header and navigation bindings. It maps Setup, Chat, and Mission to existing/new routes and owns no organization data beyond the selected context.

### `WorkspaceBootstrap`

Loads the registry and validation state, then chooses Setup or Mission. It fails into a repair surface rather than an empty or crashed route.

### `SetupView`

Owns the five-step draft and delegates serialization, validation, import, and publish to SDK endpoints. It does not write files directly.

### `KnowledgeStore`

Owns managed-copy import, manifest state, hashing, indexing, re-import, and scoped search. It is independent from TUI components.

### Existing Builder and Mission components

The existing model picker, permission editor, organization validation, Mission panels, and organization control endpoints are reused. Large existing views are composed into smaller Setup steps rather than duplicated.

## 8. Error handling and safety

- Registry, organization, manifest, and active-selection writes are atomic.
- Organization IDs and department IDs are safe path segments; traversal and absolute paths are rejected.
- An invalid active organization opens Setup repair and never starts a run.
- Failed organization switching retains the prior active organization and displays a concrete error.
- Switching with an unsaved draft requires confirmation.
- A running mission is pinned to its organization ID and cannot be redirected by changing the active organization.
- Knowledge import copies to a temporary file, hashes it, then renames it into place.
- Unsupported or unreadable knowledge is reported per file; one failure does not erase successful imports.
- Knowledge search is fail-closed on organization and department scope.
- Required text-index failure never deletes the managed copy or corrupts the prior successful index; optional semantic-index failure degrades to local search.
- Existing irreversible-action gates, budget stops, evaluator fail-safe behavior, and run locks remain unchanged.
- No symlinks are used for active organization switching.
- User-facing errors are English, actionable, and Northstar-branded.

## 9. Testing strategy

### Registry and path isolation

- create, list, select, rename, and validate project-local organizations;
- discover a legacy organization without moving files;
- reject unsafe IDs and roots;
- prove two organizations cannot resolve the same run, memory, agent, or knowledge path;
- recover from malformed registry and interrupted temporary writes.

### Setup

- first launch with no organization renders Setup;
- valid organization renders Mission;
- invalid organization renders repair mode;
- all five steps preserve draft state;
- final publish is atomic and blocked by agent/org/knowledge validation;
- generated agent Markdown round-trips through the production agent loader.

### Knowledge

- import shared and department files into the correct managed directories;
- hash/deduplicate/re-import behavior;
- binary, traversal, collision, and partial-failure handling;
- shared results reach every department;
- department results never cross department or organization boundaries;
- text/semantic indexing retry preserves the managed copy and prior index;
- local search remains available without an embedding provider.

### Navigation and organization switching

- persistent header renders on Setup, Chat/session, and Mission;
- click and `Ctrl+X S/C/M/O` bindings use the production keymap;
- Chat typing and autocomplete keep their existing bindings;
- switching refreshes agents, sessions, runs, and Mission state together;
- unsaved Setup draft guards switching;
- active background runs continue across UI switches.

### Chat and autonomous completion

- new Chat opens with the active organization's CEO;
- session and run carry the organization ID;
- plan approval starts the existing autonomous driver;
- Mission automatically selects an active/paused run;
- completion renders final deliverables and does not require a manual `/mission` command.

### Regression gates

- existing Builder, organization engine, HTTP API, autonomous-loop, and Mission Control suites remain green;
- source scan prevents Kilo branding or non-English copy in new user-facing workspace files;
- OpenCode annotation guard passes for the small shared-route/shell seams;
- SDK generation and affected typechecks pass;
- a user-facing minor changeset documents the new Northstar workspace.

## 10. Delivery decomposition

The work ships as sequential, testable waves on `main`:

1. **Organization context:** registry, legacy adapter, path isolation, active selection, HTTP/SDK seams.
2. **Setup and knowledge:** five-step Setup, agent/department authoring, staging publish, managed-copy knowledge and scoped index.
3. **Workspace shell:** bootstrap route, compact header, shortcuts, organization selector, Setup/Chat/Mission navigation.
4. **Chat handoff:** organization-bound sessions, CEO default, shared task-start path, automatic Mission selection.
5. **Wave close:** end-to-end first-launch, multi-organization isolation, autonomous completion, branding/language audit, changeset.

Each wave ends with focused tests before the next wave changes a dependent surface. Shared upstream files are modified only at narrow, annotated integration seams; most implementation lives under `src/kilocode` and `test/kilocode`.

## 11. Out of scope

- Localization or any language other than English.
- Global organizations shared across projects.
- Unlimited hierarchy depth or custom runtime delegation levels.
- Automatic live synchronization with source knowledge files.
- Arbitrary external filesystem knowledge paths.
- Organization deletion, cloud synchronization, marketplace sharing, or organization import/export.
- Changing the existing autonomous evaluator, irreversible-action policy, or budget semantics except to carry organization context.
