# Northstar Workspace and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy startup home with an English-only, project-local multi-organization workspace that guides first-run Setup and opens existing organizations directly in Mission Control.

**Architecture:** A Kilo-owned `OrgWorkspace` registry and async organization scope isolate every organization's config, agents, knowledge, runs, and memory while preserving the legacy `.kilo` layout. A persistent Northstar shell maps Setup, Chat, and Mission onto focused routes; Setup publishes staged organizations atomically, Chat binds sessions through existing metadata, and Mission reuses the autonomous engine and Cockpit.

**Tech Stack:** Bun, TypeScript, Zod, Effect HttpApi, SolidJS, OpenTUI, existing `@kilocode/sdk`, existing organization runner/conductor/RAG.

## Global Constraints

- All user-visible workspace copy is English-only and Northstar-branded.
- Organizations are named, project-local, and isolated by organization ID.
- Runtime hierarchy stays exactly three levels deep: Executive, Department Leads, Specialists.
- Imported knowledge is copied into managed storage; source files are never live-linked.
- Shared knowledge reaches every department; department knowledge never crosses department or organization boundaries.
- A local text index works without an embedding provider; semantic vectors are optional.
- Legacy `.kilo/organization.jsonc`, `.kilo/agent`, and `.kilo/org` files remain in place and usable.
- No symlinks, destructive migration, new runtime dependency, localization layer, or database migration.
- Prefer `packages/opencode/src/kilocode` and `packages/opencode/test/kilocode`; annotate every unavoidable shared OpenCode seam.
- Run tests from `packages/opencode`, never the repository root.
- A user-facing minor changeset is required.

---

## File map

### Organization context and storage

- Create `packages/opencode/src/kilocode/organization/workspace.ts`: registry schema, legacy discovery, active selection, safe path resolver, async scope.
- Create `packages/opencode/src/kilocode/organization/knowledge.ts`: managed import, manifest, local index, scoped search.
- Modify `packages/opencode/src/kilocode/organization/schema.ts`: use scoped organization/agent paths.
- Modify `packages/opencode/src/kilocode/organization/state.ts`: use scoped run paths and persist organization ID.
- Modify `packages/opencode/src/kilocode/organization/memory.ts`, `postmortem.ts`, `rag.ts`, `versions.ts`, `artifacts.ts`: resolve paths from the current organization scope.
- Modify `packages/opencode/src/kilocode/organization/tools.ts`, `driver.ts`: enter and preserve organization scope from session metadata.

### HTTP and SDK

- Create `packages/opencode/src/kilocode/server/httpapi/groups/organizations.ts`: list, stage, select, publish, knowledge import/search contracts.
- Create `packages/opencode/src/kilocode/server/httpapi/handlers/organizations.ts`: guarded handlers calling workspace/knowledge services.
- Modify `packages/opencode/src/server/routes/instance/httpapi/api.ts`: add one annotated Kilo HttpApi group.
- Modify `packages/opencode/src/kilocode/server/httpapi/server.ts`: provide organization handlers.
- Modify `packages/opencode/src/kilocode/server/httpapi/groups/org-runs.ts` and handler: accept organization ID.
- Regenerate `packages/sdk/openapi.json` and `packages/sdk/js/src/v2/gen/` through `bun run script/generate.ts`.

### Setup and workspace shell

- Create `packages/opencode/src/kilocode/setup/model.ts`: five-step draft, structured agent prompt serialization, review model.
- Create `packages/opencode/src/kilocode/setup/view.tsx`: Setup coordinator and publish flow.
- Create `packages/opencode/src/kilocode/setup/organization-step.tsx`, `departments-step.tsx`, `agents-step.tsx`, `knowledge-step.tsx`, `review-step.tsx`: focused Setup steps.
- Create `packages/opencode/src/kilocode/workspace/context.tsx`: active registry state for TUI consumers.
- Create `packages/opencode/src/kilocode/workspace/header.tsx`: organization selector and `Ctrl+X S/C/M/O` bindings.
- Create `packages/opencode/src/kilocode/workspace/bootstrap.tsx`: first-launch/repair/Mission routing.
- Create `packages/opencode/src/kilocode/workspace/shell.tsx`: persistent header wrapper.
- Modify `packages/opencode/src/cli/cmd/tui/config/keybind.ts`: reserve lowercase leader sequences for Northstar navigation and retain displaced commands on uppercase variants.
- Modify `packages/opencode/src/cli/cmd/tui/context/route.tsx`: add bootstrap/setup routes and default bootstrap.
- Modify `packages/opencode/src/cli/cmd/tui/app.tsx`: mount providers/shell and route matches behind annotated seams.
- Modify `packages/opencode/src/kilocode/cli/cmd/tui/app.tsx`: export new Kilo views/providers.

### Chat and Mission

- Create `packages/opencode/src/kilocode/organization/events.ts`: run-started/autonomous-started events carrying organization and run IDs.
- Modify `packages/opencode/src/kilocode/session/index.ts`: metadata helpers and organization filtering.
- Modify `packages/opencode/src/session/session.ts`: add active organization metadata at the existing Kilo creation seam.
- Modify `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`: filter through a Kilo helper at one annotated seam.
- Modify `packages/opencode/src/kilocode/cockpit/view.tsx`: active organization query, empty-state task action, auto-selection.
- Modify `packages/opencode/src/kilocode/kilo-commands.tsx`: preserve aliases and route through the shell.

### Tests and release note

- Create focused tests under `packages/opencode/test/kilocode/organization/`, `server/`, `setup/`, and `workspace/`.
- Create `.changeset/<generated-slug>.md` with a minor release note for `@ilura/northstar`.

---

### Task 1: Project-local organization registry and legacy discovery

**Files:**
- Create: `packages/opencode/src/kilocode/organization/workspace.ts`
- Test: `packages/opencode/test/kilocode/organization/workspace.test.ts`

**Interfaces:**
- Produces: `OrgWorkspace.Entry`, `OrgWorkspace.Registry`, `OrgWorkspace.Context`, `OrgWorkspace.Paths`.
- Produces: `OrgWorkspace.list(dir)`, `OrgWorkspace.active(dir)`, `OrgWorkspace.stage(dir, name)`, `OrgWorkspace.draft(dir, id)`, `OrgWorkspace.drafts(dir)`, `OrgWorkspace.discard(dir, id)`, `OrgWorkspace.select(dir, id)`, `OrgWorkspace.publish(dir, id)`, `OrgWorkspace.run(ctx, fn)`, `OrgWorkspace.current(dir)`.
- Consumes: Bun filesystem APIs and `AsyncLocalStorage`.

- [ ] **Step 1: Write failing registry and isolation tests**

```ts
import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"

describe("OrgWorkspace", () => {
  test("discovers the unmoved legacy organization", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, ".kilo/organization.jsonc"), '{"ceo":"ceo","departments":{"work":{"chief":"lead","workers":["worker"]}},"pipeline":[{"stage":"work"}]}')
    const registry = await OrgWorkspace.list(tmp.path)
    expect(registry.active).toBe("legacy")
    expect(registry.organizations[0]).toMatchObject({ id: "legacy", layout: "legacy" })
    expect(await Bun.file(path.join(tmp.path, ".kilo/organization.jsonc")).exists()).toBe(true)
  })

  test("managed organizations resolve disjoint roots", async () => {
    await using tmp = await tmpdir()
    const a = await OrgWorkspace.stage(tmp.path, "Product Studio")
    const b = await OrgWorkspace.stage(tmp.path, "Research Team")
    expect(a.paths.organization).not.toBe(b.paths.organization)
    expect(a.paths.runs).not.toBe(b.paths.runs)
    expect(a.paths.knowledge).not.toBe(b.paths.knowledge)
  })

  test("rejects unsafe ids", async () => {
    await using tmp = await tmpdir()
    expect(() => OrgWorkspace.paths(tmp.path, { id: "../escape", name: "x", layout: "managed", root: "x" })).toThrow("safe organization id")
    expect(() => OrgWorkspace.paths(tmp.path, { id: "safe", name: "x", layout: "managed", root: "../../escape" })).toThrow("safe organization root")
  })
})
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `cd packages/opencode && bun test test/kilocode/organization/workspace.test.ts`

Expected: FAIL because `organization/workspace.ts` does not exist.

- [ ] **Step 3: Implement the versioned registry and scoped paths**

```ts
// kilocode_change - new file
import path from "path"
import { rename, mkdir, readdir, rm } from "node:fs/promises"
import { AsyncLocalStorage } from "node:async_hooks"
import z from "zod"

export namespace OrgWorkspace {
  const Entry = z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1),
    layout: z.enum(["legacy", "managed"]),
    root: z.string().min(1),
  })
  export type Entry = z.output<typeof Entry>

  const Registry = z.object({ version: z.literal(1), active: z.string().optional(), organizations: z.array(Entry) })
  export type Registry = z.output<typeof Registry>

  export type Paths = {
    root: string
    organization: string
    agents: string
    knowledge: string
    runs: string
    memory: string
    lessons: string
    rag: string
  }
  export type Context = { projectDir: string; entry: Entry; paths: Paths }

  const scope = new AsyncLocalStorage<Context>()
  const registry = (dir: string) => path.join(dir, ".kilo", "organizations.json")
  const staging = (dir: string, id: string) => path.join(dir, ".kilo", "organizations", ".staging", id)
  const stageFile = (dir: string, id: string) => path.join(staging(dir, id), ".northstar-stage.json")
  const slug = (name: string) => name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")

  export function paths(dir: string, entry: Entry): Paths {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.id)) throw new Error("Expected a safe organization id")
    const allowed = entry.root === `organizations/${entry.id}` || entry.root === `organizations/.staging/${entry.id}`
    if (entry.layout === "managed" && !allowed) throw new Error("Expected a safe organization root")
    if (entry.layout === "legacy" && entry.root !== ".") throw new Error("Expected the legacy organization root")
    const root = entry.layout === "legacy" ? path.join(dir, ".kilo") : path.join(dir, ".kilo", entry.root)
    return entry.layout === "legacy"
      ? { root, organization: path.join(root, "organization.jsonc"), agents: path.join(root, "agent"), knowledge: path.join(root, "knowledge"), runs: path.join(root, "org", "runs"), memory: path.join(root, "org", "memory"), lessons: path.join(root, "org", "lessons.md"), rag: path.join(root, "org", "rag") }
      : { root, organization: path.join(root, "organization.jsonc"), agents: path.join(root, "agents"), knowledge: path.join(root, "knowledge"), runs: path.join(root, "runs"), memory: path.join(root, "memory"), lessons: path.join(root, "lessons.md"), rag: path.join(root, "rag") }
  }

  async function write(dir: string, value: Registry) {
    const file = registry(dir)
    const tmp = `${file}.tmp-${process.pid}`
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(tmp, JSON.stringify(value, null, 2) + "\n")
    await rename(tmp, file)
  }

  export async function list(dir: string): Promise<Registry> {
    const file = Bun.file(registry(dir))
    if (await file.exists()) return Registry.parse(await file.json())
    const legacy = await Bun.file(path.join(dir, ".kilo", "organization.jsonc")).exists()
    const value: Registry = legacy ? { version: 1, active: "legacy", organizations: [{ id: "legacy", name: "Legacy organization", layout: "legacy", root: "." }] } : { version: 1, organizations: [] }
    if (legacy) await write(dir, value)
    return value
  }

  export async function stage(dir: string, name: string): Promise<Context> {
    const id = slug(name)
    if (!id) throw new Error("Organization name must contain a letter or number")
    const current = await list(dir)
    if (current.organizations.some((item) => item.id === id) || await Bun.file(stageFile(dir, id)).exists()) throw new Error(`Organization '${id}' already exists`)
    const entry: Entry = { id, name: name.trim(), layout: "managed", root: `organizations/.staging/${id}` }
    const ctx = { projectDir: dir, entry, paths: paths(dir, entry) }
    await mkdir(ctx.paths.root, { recursive: true })
    await Bun.write(stageFile(dir, id), JSON.stringify(entry, null, 2) + "\n")
    return ctx
  }

  export async function draft(dir: string, id: string): Promise<Context> {
    const entry = Entry.parse(await Bun.file(stageFile(dir, id)).json())
    return { projectDir: dir, entry, paths: paths(dir, entry) }
  }

  export async function drafts(dir: string): Promise<Context[]> {
    const entries = await readdir(path.join(dir, ".kilo", "organizations", ".staging"), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))
    const values = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => draft(dir, entry.name).catch(() => undefined)))
    return values.filter((value): value is Context => value !== undefined)
  }

  export async function discard(dir: string, id: string) {
    await draft(dir, id)
    await rm(staging(dir, id), { recursive: true, force: true })
  }

  export async function resolve(dir: string, id?: string): Promise<Context> {
    const value = await list(dir)
    const selected = id ?? value.active
    const entry = value.organizations.find((item) => item.id === selected)
    if (!entry) throw new Error(selected ? `Unknown organization '${selected}'` : "No active organization")
    return { projectDir: dir, entry, paths: paths(dir, entry) }
  }

  export async function active(dir: string): Promise<Context | undefined> {
    const value = await list(dir)
    if (!value.active) return
    return resolve(dir, value.active)
  }

  export async function select(dir: string, id: string): Promise<Context> {
    const value = await list(dir)
    const entry = value.organizations.find((item) => item.id === id)
    if (!entry) throw new Error(`Unknown organization '${id}'`)
    await write(dir, { ...value, active: id })
    return { projectDir: dir, entry, paths: paths(dir, entry) }
  }

  export async function publish(dir: string, id: string): Promise<Context> {
    const staged = await draft(dir, id)
    const entry = Entry.parse({ ...staged.entry, root: `organizations/${id}` })
    const source = staging(dir, id)
    const target = paths(dir, entry).root
    if (await Bun.file(target).exists()) throw new Error(`Organization '${id}' already exists`)
    await rm(stageFile(dir, id))
    await rename(source, target)
    try {
      const value = await list(dir)
      if (value.organizations.some((item) => item.id === id)) throw new Error(`Organization '${id}' already exists`)
      await write(dir, { version: 1, active: id, organizations: [...value.organizations, entry] })
      return { projectDir: dir, entry, paths: paths(dir, entry) }
    } catch (error) {
      await rename(target, source)
      await Bun.write(stageFile(dir, id), JSON.stringify(staged.entry, null, 2) + "\n")
      throw error
    }
  }

  export function run<A>(ctx: Context, fn: () => A): A { return scope.run(ctx, fn) }
  export function current(dir: string): Context | undefined { const ctx = scope.getStore(); return ctx?.projectDir === dir ? ctx : undefined }
}
```

Before `publish` renames the directory, parse the staged organization and every staged agent with `OrgSchema`/agent frontmatter validation. The rollback branch restores the staging marker when the registry write fails, so the draft remains repairable and never appears in `list`.

- [ ] **Step 4: Run focused tests**

Run: `cd packages/opencode && bun test test/kilocode/organization/workspace.test.ts`

Expected: all registry, legacy, slug, atomic-selection, and path-isolation tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/workspace.ts packages/opencode/test/kilocode/organization/workspace.test.ts
git commit -m "feat(org): add project-local organization registry"
```

### Task 2: Scope existing organization storage without moving legacy files

**Files:**
- Modify: `packages/opencode/src/kilocode/organization/schema.ts`
- Modify: `packages/opencode/src/kilocode/organization/state.ts`
- Modify: `packages/opencode/src/kilocode/organization/artifacts.ts`
- Modify: `packages/opencode/src/kilocode/organization/versions.ts`
- Modify: `packages/opencode/src/kilocode/organization/memory.ts`
- Modify: `packages/opencode/src/kilocode/organization/postmortem.ts`
- Modify: `packages/opencode/src/kilocode/organization/rag.ts`
- Modify: `packages/opencode/src/kilocode/organization/driver.ts`
- Test: `packages/opencode/test/kilocode/organization/workspace-isolation.test.ts`

**Interfaces:**
- Consumes: `OrgWorkspace.current(projectDir)` and `OrgWorkspace.run(context, fn)`.
- Produces: existing organization APIs with organization-scoped paths and byte-compatible legacy fallback.

- [ ] **Step 1: Write a failing two-organization runner isolation test**

```ts
test("the same run id cannot cross organization roots", async () => {
  await using tmp = await tmpdir()
  const a = await published(tmp.path, "Alpha")
  const b = await published(tmp.path, "Beta")
  await OrgWorkspace.run(a, () => OrgState.create(tmp.path, ORG, "same idea", undefined, undefined, new Date("2026-01-01")))
  expect(await OrgWorkspace.run(b, () => OrgState.list(tmp.path))).toEqual([])
  expect(await OrgWorkspace.run(a, () => OrgState.list(tmp.path))).toHaveLength(1)
})
```

- [ ] **Step 2: Verify the test fails against legacy hard-coded paths**

Run: `cd packages/opencode && bun test test/kilocode/organization/workspace-isolation.test.ts`

Expected: FAIL because both organizations resolve `.kilo/org/runs`.

- [ ] **Step 3: Route every path helper through the organization scope**

Use this exact pattern in each module:

```ts
import { OrgWorkspace } from "./workspace"

function paths(projectDir: string) {
  return OrgWorkspace.current(projectDir)?.paths
}

export function runsDir(projectDir: string): string {
  return paths(projectDir)?.runs ?? path.join(projectDir, ".kilo", "org", "runs")
}
```

Map `organization`, `agents`, `runs`, `memory`, `lessons`, and `rag` to their matching `OrgWorkspace.Paths` member. Keep every existing fallback exactly as the legacy path. Add `organizationID: z.string().optional()` to `OrgState.Run`; set it from the current scope in `OrgState.create`:

```ts
const organizationID = OrgWorkspace.current(projectDir)?.entry.id
return Run.parse({ ...existing, ...(organizationID ? { organizationID } : {}) })
```

Wrap the entire driver flight so async work retains scope:

```ts
const flight = OrgWorkspace.run(input.organization, () => OrgConductor.drive(input.runID, deps))
```

Add `organization: OrgWorkspace.Context` to `OrgDriver.attach` and update current callers after they resolve the active/session organization.

- [ ] **Step 4: Run isolation and existing engine tests**

Run: `cd packages/opencode && bun test test/kilocode/organization/workspace-isolation.test.ts test/kilocode/organization/state.test.ts test/kilocode/organization/autonomous-loop-exit.test.ts test/kilocode/organization/org-memory.test.ts test/kilocode/organization/org-rag.test.ts`

Expected: PASS with legacy snapshots unchanged and managed roots isolated.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization packages/opencode/test/kilocode/organization/workspace-isolation.test.ts
git commit -m "refactor(org): scope runtime storage by organization"
```

### Task 3: Managed knowledge copies and provider-free local search

**Files:**
- Create: `packages/opencode/src/kilocode/organization/knowledge.ts`
- Test: `packages/opencode/test/kilocode/organization/knowledge.test.ts`

**Interfaces:**
- Produces: `OrgKnowledge.importFiles(context, input)`, `OrgKnowledge.search(context, input)`, `OrgKnowledge.manifest(context)`.
- Input scope: `{ type: "shared" } | { type: "department"; departmentID: string }`.
- Supported initial files: UTF-8 text files accepted by the production text reader; binary/NUL input is rejected.

- [ ] **Step 1: Write failing import and scope tests**

```ts
test("copies shared and department sources and searches without embeddings", async () => {
  await using tmp = await tmpdir()
  const ctx = await managed(tmp.path, "Studio")
  await Bun.write(path.join(tmp.path, "brief.md"), "Northstar launch acceptance evidence")
  const items = await OrgKnowledge.importFiles(ctx, { sources: ["brief.md"], scope: { type: "department", departmentID: "engineering" } })
  const item = items.find((value) => value.source === "brief.md")!
  expect(path.dirname(item.managed)).toBe(path.join(ctx.paths.knowledge, "departments/engineering"))
  expect(await Bun.file(item.managed).exists()).toBe(true)
  expect((await OrgKnowledge.search(ctx, { query: "acceptance evidence", departmentID: "engineering" })).length).toBeGreaterThan(0)
  expect(await OrgKnowledge.search(ctx, { query: "acceptance evidence", departmentID: "research" })).toEqual([])
})

test("rejects workspace escapes and binary input", async () => {
  await expect(OrgKnowledge.importFiles(ctx, { sources: ["../secret"], scope: { type: "shared" } })).rejects.toThrow("inside the workspace")
  await Bun.write(path.join(tmp.path, "binary.bin"), new Uint8Array([0, 1, 2]))
  await expect(OrgKnowledge.importFiles(ctx, { sources: ["binary.bin"], scope: { type: "shared" } })).rejects.toThrow("text knowledge")
})
```

- [ ] **Step 2: Run tests and verify missing API failures**

Run: `cd packages/opencode && bun test test/kilocode/organization/knowledge.test.ts`

Expected: FAIL because `OrgKnowledge` does not exist.

- [ ] **Step 3: Implement atomic managed copies, manifest, and local index**

```ts
export namespace OrgKnowledge {
  const SAFE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  const Scope = z.discriminatedUnion("type", [z.object({ type: z.literal("shared") }), z.object({ type: z.literal("department"), departmentID: z.string().regex(SAFE) })])
  const Item = z.object({ id: z.string(), source: z.string(), managed: z.string(), scope: Scope, hash: z.string(), size: z.number(), importedAt: z.string() })
  const Document = z.object({ id: z.string(), managed: z.string(), scope: z.string(), tokens: z.array(z.string()), excerpt: z.string() })
  const Manifest = z.object({ version: z.literal(1), items: z.array(Item) })
  const Index = z.object({ version: z.literal(1), documents: z.array(Document) })
  type Catalog = { version: 1; items: z.output<typeof Item>[]; documents: z.output<typeof Document>[] }

  const manifestPath = (ctx: OrgWorkspace.Context) => path.join(ctx.paths.knowledge, "manifest.json")
  const indexPath = (ctx: OrgWorkspace.Context) => path.join(ctx.paths.knowledge, "index.json")

  async function catalog(ctx: OrgWorkspace.Context): Promise<Catalog> {
    const manifest = Bun.file(manifestPath(ctx))
    const index = Bun.file(indexPath(ctx))
    return {
      version: 1,
      items: await manifest.exists() ? Manifest.parse(await manifest.json()).items : [],
      documents: await index.exists() ? Index.parse(await index.json()).documents : [],
    }
  }

  async function commit(ctx: OrgWorkspace.Context, value: Catalog) {
    const id = `${process.pid}-${crypto.randomUUID()}`
    const files = [
      { file: manifestPath(ctx), tmp: `${manifestPath(ctx)}.tmp-${id}`, backup: `${manifestPath(ctx)}.bak-${id}`, value: { version: 1, items: value.items } },
      { file: indexPath(ctx), tmp: `${indexPath(ctx)}.tmp-${id}`, backup: `${indexPath(ctx)}.bak-${id}`, value: { version: 1, documents: value.documents } },
    ]
    await mkdir(ctx.paths.knowledge, { recursive: true })
    await Promise.all(files.map((item) => Bun.write(item.tmp, JSON.stringify(item.value, null, 2) + "\n")))
    const prior = await Promise.all(files.map(async (item) => {
      if (!await Bun.file(item.file).exists()) return false
      await rename(item.file, item.backup)
      return true
    }))
    try {
      for (const item of files) await rename(item.tmp, item.file)
      await Promise.all(files.map((item) => rm(item.backup, { force: true })))
    } catch (error) {
      await Promise.all(files.map((item, index) => rm(item.file, { force: true }).then(() => prior[index] ? rename(item.backup, item.file) : undefined)))
      throw error
    }
  }

  async function source(ctx: OrgWorkspace.Context, input: string) {
    const file = path.resolve(ctx.projectDir, input)
    const relative = path.relative(ctx.projectDir, file)
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Knowledge files must be inside the workspace")
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (bytes.includes(0)) throw new Error("Only text knowledge files are supported")
    try {
      return { file, relative, bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
    } catch {
      throw new Error("Only text knowledge files are supported")
    }
  }

  function tokens(text: string) {
    return [...new Set(text.toLowerCase().normalize("NFKC").split(/[^a-z0-9]+/).filter((part) => part.length > 1))]
  }

  async function semantic(ctx: OrgWorkspace.Context, value: Catalog) {
    const { KiloIndexing } = await import("@/kilocode/indexing")
    const services = await KiloIndexing.orgRagServices(ctx.projectDir)
    if (!services) return
    const contents = await Promise.all(value.documents.map((document) => Bun.file(document.managed).text()))
    const embedded = await services.embedder.createEmbeddings(contents)
    await services.store.upsertPoints(value.documents.map((document, index) => {
      const item = value.items.find((candidate) => candidate.id === document.id)!
      const hash = new Bun.CryptoHasher("sha256").update(`knowledge:${document.id}`).digest("hex")
      return {
        id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
        vector: embedded.embeddings[index] ?? [],
        payload: { filePath: document.managed, fileHash: item.hash, codeChunk: contents[index]!, startLine: 1, endLine: contents[index]!.split("\n").length },
      }
    }))
  }

  export async function importFiles(ctx: OrgWorkspace.Context, input: { sources: string[]; scope: z.output<typeof Scope> }) {
    const before = await catalog(ctx)
    let next = before
    const replaced: string[] = []
    for (const name of input.sources) {
      const data = await source(ctx, name)
      const hash = new Bun.CryptoHasher("sha256").update(data.bytes).digest("hex")
      const scope = input.scope.type === "shared" ? "shared" : `department:${input.scope.departmentID}`
      const folder = input.scope.type === "shared" ? path.join(ctx.paths.knowledge, "shared") : path.join(ctx.paths.knowledge, "departments", input.scope.departmentID)
      const managed = path.join(folder, `${hash.slice(0, 12)}-${path.basename(data.file)}`)
      const tmp = `${managed}.tmp-${process.pid}`
      await mkdir(folder, { recursive: true })
      await Bun.write(tmp, data.bytes)
      await rename(tmp, managed)
      const id = `${scope}:${data.relative}`
      const prior = next.items.find((item) => item.id === id)
      if (prior && prior.managed !== managed) replaced.push(prior.managed)
      const item = Item.parse({ id, source: data.relative, managed, scope: input.scope, hash, size: data.bytes.byteLength, importedAt: new Date().toISOString() })
      const document = Document.parse({ id, managed, scope, tokens: tokens(data.text), excerpt: data.text.slice(0, 500) })
      next = {
        version: 1,
        items: [...next.items.filter((value) => value.id !== id), item],
        documents: [...next.documents.filter((value) => value.id !== id), document],
      }
    }
    await commit(ctx, next)
    await Promise.all(replaced.map((file) => rm(file, { force: true })))
    void semantic(ctx, next).catch((error) => Log.warn("Semantic knowledge indexing unavailable", { error }))
    return next.items
  }

  export async function manifest(ctx: OrgWorkspace.Context) {
    return (await catalog(ctx)).items
  }

  export async function search(ctx: OrgWorkspace.Context, input: { query: string; departmentID: string; limit?: number }) {
    const allowed = new Set(["shared", `department:${input.departmentID}`])
    const index = await catalog(ctx)
    const query = tokens(input.query)
    return index.documents.filter((doc) => allowed.has(doc.scope) && query.some((token) => doc.tokens.includes(token))).slice(0, input.limit ?? 8)
  }
}
```

Prepare `manifest.json` and `index.json` temporary files together, move existing versions to per-transaction backups, and restore both backups if either replacement fails. Content-addressed managed filenames leave the prior manifest/index and file readable until commit; old managed files are removed only afterward. Invalid UTF-8 from the fatal decoder is translated to the same `Only text knowledge files are supported` domain error tested above. When `KiloIndexing.orgRagServices` returns an embedder/store, enqueue best-effort semantic indexing after this provider-free commit; log failures and never downgrade the successful local import.

- [ ] **Step 4: Run knowledge tests**

Run: `cd packages/opencode && bun test test/kilocode/organization/knowledge.test.ts`

Expected: PASS for import, re-import, dedupe, traversal, binary rejection, shared visibility, department isolation, and no-embedder search.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/knowledge.ts packages/opencode/test/kilocode/organization/knowledge.test.ts
git commit -m "feat(org): add managed scoped knowledge"
```

### Task 4: Organization management HTTP API and generated SDK

**Files:**
- Create: `packages/opencode/src/kilocode/server/httpapi/groups/organizations.ts`
- Create: `packages/opencode/src/kilocode/server/httpapi/handlers/organizations.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/api.ts`
- Modify: `packages/opencode/src/kilocode/server/httpapi/server.ts`
- Test: `packages/opencode/test/kilocode/server/organizations.test.ts`
- Regenerate: `packages/sdk/openapi.json`
- Regenerate: `packages/sdk/js/src/v2/gen/sdk.gen.ts`
- Regenerate: `packages/sdk/js/src/v2/gen/types.gen.ts`

**Interfaces:**
- Produces SDK client `client.organizations.list`, `.get`, `.stage`, `.saveDraft`, `.discardDraft`, `.update`, `.select`, `.publish`, `.importKnowledge`, `.searchKnowledge`.
- Consumes `OrgWorkspace` and `OrgKnowledge` from Tasks 1 and 3.

- [ ] **Step 1: Write failing real-handler tests**

```ts
test("stage, publish, list and select organizations", async () => {
  const staged = await OrganizationsHandler.stage(dir, { name: "Product Studio" })
  await OrganizationsHandler.saveDraft(dir, {
    organizationID: staged.organization.id,
    organization: organizationFixture(),
    agents: agentFixtures(),
  })
  const published = await OrganizationsHandler.publish(dir, { organizationID: staged.organization.id })
  expect(published.active).toBe("product-studio")
  const list = await OrganizationsHandler.list(dir)
  expect(list.organizations.map((item) => item.id)).toEqual(["product-studio"])
})
```

- [ ] **Step 2: Run the handler test and verify missing modules**

Run: `cd packages/opencode && bun test test/kilocode/server/organizations.test.ts`

Expected: FAIL because the group and handler do not exist.

- [ ] **Step 3: Define the Effect HttpApi contract**

```ts
export const OrganizationQuery = Schema.Struct({ organizationID: Schema.optional(Schema.String) })
export const OrganizationPaths = {
  list: "/organizations",
  get: "/organizations/:organizationID",
  stage: "/organizations/staging",
  save: "/organizations/staging/:organizationID",
  discard: "/organizations/staging/:organizationID/discard",
  update: "/organizations/:organizationID",
  select: "/organizations/:organizationID/select",
  publish: "/organizations/:organizationID/publish",
  knowledge: "/organizations/:organizationID/knowledge/import",
  search: "/organizations/:organizationID/knowledge/search",
} as const
```

`saveDraft` accepts `{ draft: SetupModel.Draft, organization: OrgSchema.Organization, agents: Array<{ id: string; content: string }> }`, parses every payload, rejects duplicate/unsafe agent IDs, then writes `.northstar-setup.json`, `organization.jsonc`, and a prepared `agents/` directory inside `OrgWorkspace.draft`. Because staging is not runtime-visible, a failed save remains a resumable draft and cannot affect the active organization. `get` returns the structured setup draft plus validation state for either a published entry or staged draft. `update` prepares and validates a replacement organization/agent definition, swaps it into a published root with rollback backups, updates the registry display name, and leaves knowledge/runs/memory untouched. `discardDraft` calls `OrgWorkspace.discard` only for an unpublished ID. Knowledge import resolves either a published entry or that staged context; list/search/run endpoints resolve published entries only. Add endpoints with `WorkspaceRoutingQuery` merged with `OrganizationQuery`, `Authorization`, `InstanceContextMiddleware`, and `WorkspaceRoutingMiddleware`. Every handler resolves the workspace from `InstanceState.context`, calls the plain async handler function, and disposes `InstanceStore` only after select/publish/update succeeds.

- [ ] **Step 4: Register handlers and API at annotated seams**

In `api.ts`, add `OrganizationsApi` beside `OrgBuilderApi`; in Kilo `server.ts`, add `organizationsHandlers` beside `orgBuilderHandlers`. Wrap the shared import/add lines with existing `kilocode_change` blocks.

- [ ] **Step 5: Run server tests before SDK generation**

Run: `cd packages/opencode && bun test test/kilocode/server/organizations.test.ts`

Expected: PASS for authorization-independent plain handlers and HttpApi schema wiring.

- [ ] **Step 6: Regenerate SDK and verify generated methods**

Run: `bun run script/generate.ts`

Expected: generated `Organizations` client exposes all ten operations and no unrelated generated diff remains.

- [ ] **Step 7: Run typechecks and commit**

Run: `cd packages/opencode && bun run typecheck`

Expected: PASS.

```bash
git add packages/opencode/src/kilocode/server/httpapi packages/opencode/src/server/routes/instance/httpapi/api.ts packages/opencode/test/kilocode/server/organizations.test.ts packages/sdk/openapi.json packages/sdk/js/src/v2/gen
git commit -m "feat(api): expose project organization management"
```

### Task 5: Carry organization scope through run APIs and tools

**Files:**
- Modify: `packages/opencode/src/kilocode/server/httpapi/groups/org-runs.ts`
- Modify: `packages/opencode/src/kilocode/server/httpapi/handlers/org-runs.ts`
- Modify: `packages/opencode/src/kilocode/organization/tools.ts`
- Modify: `packages/opencode/src/kilocode/organization/driver-session.ts`
- Test: `packages/opencode/test/kilocode/server/org-runs-organization.test.ts`
- Test: `packages/opencode/test/kilocode/organization/tool-organization-scope.test.ts`

**Interfaces:**
- Consumes organization ID from HTTP query or `session.metadata.northstarOrganizationID`.
- Produces run responses isolated to that organization and driver flights pinned to `OrgWorkspace.Context`.

- [ ] **Step 1: Write failing cross-organization API tests**

```ts
test("org-runs list only returns the requested organization", async () => {
  await seedRun(alpha, "alpha run")
  await seedRun(beta, "beta run")
  expect((await OrgRunsView.list(dir, "alpha")).runs.map((run) => run.idea)).toEqual(["alpha run"])
  expect((await OrgRunsView.list(dir, "beta")).runs.map((run) => run.idea)).toEqual(["beta run"])
})
```

- [ ] **Step 2: Run tests and verify the current leak**

Run: `cd packages/opencode && bun test test/kilocode/server/org-runs-organization.test.ts test/kilocode/organization/tool-organization-scope.test.ts`

Expected: FAIL because org-runs and tools resolve only the workspace.

- [ ] **Step 3: Add organization query and scope wrappers**

Merge this field into every org-runs query:

```ts
export const OrgRunQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  organizationID: Schema.optional(Schema.String),
})
```

Resolve and wrap every read/mutation:

```ts
const orgctx = yield* Effect.promise(() => OrgWorkspace.resolve(instance.directory, ctx.query.organizationID))
return yield* Effect.promise(() => OrgWorkspace.run(orgctx, () => OrgRunsView.detail(instance.directory, ctx.params.runID)))
```

In organization tools, read the owner session and resolve:

```ts
const owner = yield* sessions.get(ctx.sessionID)
const id = typeof owner.metadata?.northstarOrganizationID === "string" ? owner.metadata.northstarOrganizationID : undefined
const orgctx = yield* Effect.promise(() => OrgWorkspace.resolve(instance.directory, id))
```

Wrap the full tool mutation and pass `organization: orgctx` to `OrgDriver.attach`.

- [ ] **Step 4: Regenerate SDK, run focused tests, and commit**

Run: `bun run script/generate.ts`

Run: `cd packages/opencode && bun test test/kilocode/server/org-runs-organization.test.ts test/kilocode/organization/tool-organization-scope.test.ts test/kilocode/cockpit/mission-control-integration.test.tsx`

Expected: PASS; existing clients without organization ID retain legacy behavior.

```bash
git add packages/opencode/src/kilocode packages/sdk/openapi.json packages/sdk/js/src/v2/gen packages/opencode/test/kilocode
git commit -m "feat(org): pin tools and runs to organization context"
```

### Task 6: Pure Setup draft, validation, and agent serialization

**Files:**
- Create: `packages/opencode/src/kilocode/setup/model.ts`
- Test: `packages/opencode/test/kilocode/setup/model.test.ts`

**Interfaces:**
- Produces `SetupModel.Draft`, `SetupModel.blank(name)`, `SetupModel.issues(draft)`, `SetupModel.organization(draft)`, `SetupModel.agent(agent)`.
- Consumes existing `OrgSchema` and AgentBuilder-compatible frontmatter.

- [ ] **Step 1: Write failing model tests**

```ts
test("serializes fixed layers and structured agent behavior", () => {
  const draft = fixture()
  const org = SetupModel.organization(draft)
  expect(org.layers).toEqual({ executive: { name: "Executive", mission: "Set direction" }, leads: { name: "Department Leads", mission: "Coordinate departments" }, specialists: { name: "Specialists", mission: "Produce verified work" } })
  const agent = SetupModel.agent(draft.agents[0])
  expect(agent).toContain("# Role\n\nOwn product direction")
  expect(agent).toContain("# Do\n\n- Approve measurable plans")
  expect(agent).toContain("# Don't\n\n- Implement specialist work")
})
```

- [ ] **Step 2: Run the test and verify missing module failure**

Run: `cd packages/opencode && bun test test/kilocode/setup/model.test.ts`

Expected: FAIL because `setup/model.ts` does not exist.

- [ ] **Step 3: Implement schemas and deterministic serialization**

```ts
export namespace SetupModel {
  export const Layer = z.object({ name: z.string().trim().min(1), mission: z.string().trim().min(1) })
  export const Agent = z.object({ id: z.string().regex(SAFE), name: z.string().trim().min(1), layer: z.enum(["executive", "leads", "specialists"]), departmentID: z.string().optional(), role: z.string().trim().min(1), do: z.array(z.string().trim().min(1)), dont: z.array(z.string().trim().min(1)), providerID: z.string().min(1), modelID: z.string().min(1), permission: z.record(z.string(), z.enum(["allow", "ask", "deny"])) })
  export const Knowledge = z.object({ sources: z.array(z.string().min(1)).min(1), status: z.record(z.string(), z.enum(["pending", "imported", "indexed", "unchanged", "failed"])), scope: z.discriminatedUnion("type", [z.object({ type: z.literal("shared") }), z.object({ type: z.literal("department"), departmentID: z.string().regex(SAFE) })]) })
  export const Draft = z.object({ id: z.string(), name: z.string(), step: z.enum(["organization", "departments", "agents", "knowledge", "review"]), layers: z.object({ executive: Layer, leads: Layer, specialists: Layer }), departments: z.array(z.object({ id: z.string().regex(SAFE), name: z.string().min(1), mission: z.string().min(1), chief: z.string(), workers: z.array(z.string()) })), agents: z.array(Agent), knowledge: z.array(Knowledge), pipeline: z.array(z.object({ stage: z.string(), requires: z.array(z.string()).optional() })) })
  export type Draft = z.output<typeof Draft>

  export function agent(input: z.output<typeof Agent>) {
    return `---\ndescription: ${JSON.stringify(input.name)}\nmode: ${input.layer === "executive" ? "primary" : "subagent"}\nmodel: ${input.providerID}/${input.modelID}\n---\n\n# Role\n\n${input.role}\n\n# Do\n\n${input.do.map((item) => `- ${item}`).join("\n")}\n\n# Don't\n\n${input.dont.map((item) => `- ${item}`).join("\n")}\n`
  }
}
```

Extend `OrgSchema.Organization` with optional English display metadata `name`, `layers`, department `name`, and department `mission`; optional fields preserve every existing fixture. `issues` must enforce exactly one executive, one chief per department, specialists assigned to one department, and no duplicate IDs.

- [ ] **Step 4: Run model/schema tests and commit**

Run: `cd packages/opencode && bun test test/kilocode/setup/model.test.ts test/kilocode/organization/schema.test.ts test/kilocode/organization/templates.test.ts`

Expected: PASS.

```bash
git add packages/opencode/src/kilocode/setup/model.ts packages/opencode/src/kilocode/organization/schema.ts packages/opencode/test/kilocode/setup/model.test.ts packages/opencode/test/kilocode/organization/schema.test.ts
git commit -m "feat(setup): model organizations and agent roles"
```

### Task 7: Five-step Setup TUI and atomic publication

**Files:**
- Create: `packages/opencode/src/kilocode/setup/view.tsx`
- Create: `packages/opencode/src/kilocode/setup/organization-step.tsx`
- Create: `packages/opencode/src/kilocode/setup/departments-step.tsx`
- Create: `packages/opencode/src/kilocode/setup/agents-step.tsx`
- Create: `packages/opencode/src/kilocode/setup/knowledge-step.tsx`
- Create: `packages/opencode/src/kilocode/setup/review-step.tsx`
- Modify: `packages/opencode/src/kilocode/server/httpapi/groups/organizations.ts`
- Modify: `packages/opencode/src/kilocode/server/httpapi/handlers/organizations.ts`
- Test: `packages/opencode/test/kilocode/setup/setup-integration.test.tsx`

**Interfaces:**
- Consumes `client.organizations.get/stage/saveDraft/discardDraft/update/importKnowledge/publish`, provider/model data, and `SetupModel`.
- Produces `SetupView` with steps `organization`, `departments`, `agents`, `knowledge`, `review`.

- [ ] **Step 1: Write a failing render/publish integration test**

```ts
test("first-run Setup walks five steps and publishes", async () => {
  const tui = await renderSetup({ organizations: [], providers: providerFixture() })
  expect(tui.frame()).toContain("Create your organization")
  await tui.fillOrganization("Product Studio")
  await tui.addDepartment({ name: "Engineering", mission: "Build verified software" })
  await tui.addRequiredAgents()
  await tui.importKnowledge("brief.md", "engineering")
  await tui.review()
  expect(tui.frame()).toContain("Review and create")
  await tui.submit()
  expect(tui.calls.publish).toEqual(["product-studio"])
})

test("resumes a staged draft and edits a published organization", async () => {
  const draft = await seedSetupDraft("product-studio", { step: "agents" })
  const resumed = await renderSetup({ organizations: [], drafts: [draft] })
  expect(resumed.step()).toBe("agents")
  await resumed.closeAndReopen()
  expect(resumed.step()).toBe("agents")

  const editing = await renderSetup({ active: publishedFixture() })
  await editing.renameOrganization("Product Studio 2")
  await editing.submit()
  expect(editing.calls.update).toEqual(["product-studio"])
})
```

- [ ] **Step 2: Run test and verify missing-view failure**

Run: `cd packages/opencode && bun test test/kilocode/setup/setup-integration.test.tsx`

Expected: FAIL because Setup components do not exist.

- [ ] **Step 3: Implement the coordinator and focused steps**

Use a single draft store in `view.tsx`:

```tsx
const STEPS = ["organization", "departments", "agents", "knowledge", "review"] as const
const initial = props.draft ?? SetupModel.blank(props.name ?? "")
const [step, setStep] = createSignal<(typeof STEPS)[number]>(initial.step)
const [draft, setDraft] = createStore(initial)
const issues = createMemo(() => SetupModel.issues(draft))
```

Each step receives only its draft slice and callbacks. Leaving the Organization step for a new organization calls `stage` once, stores the returned ID, and calls `saveDraft`; every later step transition saves `.northstar-setup.json` with the current step before navigation. Bootstrap uses `OrgWorkspace.drafts` to resume the newest valid draft when no published organization exists. `Discard draft` calls `discardDraft` after confirmation.

`Import and read` immediately saves the draft, calls `importKnowledge` for its staged ID, and records per-file `imported`, `indexed`, `unchanged`, or `failed` status returned by the server. `ReviewStep` disables `Create organization` while `issues().length > 0` or knowledge has pending/failed required text-index status.

On new-organization submit, execute this ordered transaction and retain `stagedID` in component state for an in-place retry after any failure:

```ts
const staged = stagedID()
if (!staged) throw new Error("Setup draft was not staged")
await client.organizations.saveDraft({
  organizationID: staged,
  draft: { ...draft, step: "review" },
  organization: SetupModel.organization(draft),
  agents: draft.agents.map((item) => ({ id: item.id, content: SetupModel.agent(item) })),
})
await client.organizations.publish({ organizationID: staged })
await sdk.instance.dispose()
await sync.bootstrap()
props.onPublished(staged)
```

For `{ organizationID }` edit mode, load `get`; when `.northstar-setup.json` is absent (legacy or pre-Setup organization), reconstruct the draft from parsed organization and agent files. The submit label is `Save changes` and calls `update` rather than `stage/publish`. Repair mode uses the same update path but starts on the first invalid step and keeps Mission unavailable until validation passes.

If save/import/publish/update fails, keep the user on the current step with `Could not save organization: <reason>`. After create success, clear the staged state; after update success, clear dirty state. Use production `DialogPrompt`, `DialogSelect`, model options, permission cycles, and file finder. Every label/error/action in these files must be English.

- [ ] **Step 4: Run Setup integration and server tests**

Run: `cd packages/opencode && bun test test/kilocode/setup/setup-integration.test.tsx test/kilocode/server/organizations.test.ts test/kilocode/agent/builder-org-fields.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/setup packages/opencode/src/kilocode/server/httpapi packages/opencode/test/kilocode/setup packages/opencode/test/kilocode/server/organizations.test.ts
git commit -m "feat(tui): add guided organization setup"
```

### Task 8: Persistent shell, bootstrap route, and direct Mission shortcut

**Files:**
- Create: `packages/opencode/src/kilocode/workspace/context.tsx`
- Create: `packages/opencode/src/kilocode/workspace/header.tsx`
- Create: `packages/opencode/src/kilocode/workspace/bootstrap.tsx`
- Create: `packages/opencode/src/kilocode/workspace/shell.tsx`
- Modify: `packages/opencode/src/cli/cmd/tui/config/keybind.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/context/route.tsx`
- Modify: `packages/opencode/src/cli/cmd/tui/app.tsx`
- Modify: `packages/opencode/src/kilocode/cli/cmd/tui/app.tsx`
- Test: `packages/opencode/test/kilocode/workspace/bootstrap.test.tsx`
- Test: `packages/opencode/test/kilocode/workspace/header.test.tsx`

**Interfaces:**
- Produces routes `{ type: "northstar" }` and `{ type: "setup"; organizationID?: string; repair?: boolean }`.
- Produces `WorkspaceProvider`, `WorkspaceShell`, `WorkspaceBootstrap`, `WorkspaceHeader`.
- Consumes generated organization SDK and existing home/session/cockpit routes.

- [ ] **Step 1: Write failing startup and shortcut tests**

```ts
test("no organization routes to Setup", async () => {
  const app = await renderBootstrap({ organizations: [], active: undefined })
  await app.settled()
  expect(app.route()).toEqual({ type: "setup" })
})

test("an unpublished draft resumes in Setup", async () => {
  const app = await renderBootstrap({ organizations: [], active: undefined, drafts: [{ id: "studio", updatedAt: 2 }] })
  await app.settled()
  expect(app.route()).toEqual({ type: "setup", organizationID: "studio" })
})

test("valid active organization routes to Mission", async () => {
  const app = await renderBootstrap({ organizations: [{ id: "studio", valid: true }], active: "studio" })
  await app.settled()
  expect(app.route()).toEqual({ type: "cockpit" })
})

test("ctrl+x m opens Mission from Chat", async () => {
  const app = await renderHeader({ route: { type: "session", sessionID: "ses_1" } })
  await app.press("ctrl+x", "m")
  expect(app.route()).toEqual({ type: "cockpit" })
})
```

- [ ] **Step 2: Run tests and verify route/view failures**

Run: `cd packages/opencode && bun test test/kilocode/workspace/bootstrap.test.tsx test/kilocode/workspace/header.test.tsx`

Expected: FAIL because routes and workspace components do not exist.

- [ ] **Step 3: Add narrow shared route seams**

In `route.tsx`, add inside a `kilocode_change` block:

```ts
export type NorthstarRoute = { type: "northstar" }
export type SetupRoute = { type: "setup"; organizationID?: string; repair?: boolean }
```

Add both to `Route`; change only the no-argument default and `back()` fallback from `{ type: "home" }` to `{ type: "northstar" }`. Preserve explicit `initialRoute` for `--continue`.

In `app.tsx`, wrap the route switch with exported Kilo `WorkspaceProvider` and `WorkspaceShell`, then add `northstar` and `setup` matches. Keep all changes in the existing Kilo annotation block.

- [ ] **Step 4: Reserve configurable leader bindings without losing existing commands**

In `config/keybind.ts`, change the three displaced defaults and add Northstar definitions:

```ts
status_view: keybind("<leader>S", "View status"),
session_compact: keybind("<leader>C", "Compact the session"),
model_list: keybind("<leader>M", "List available models"),

// kilocode_change start - Northstar workspace navigation owns lowercase leader letters
northstar_setup: keybind("<leader>s", "Open Northstar Setup"),
northstar_chat: keybind("<leader>c", "Open Northstar Chat"),
northstar_mission: keybind("<leader>m", "Open Northstar Mission"),
northstar_organization: keybind("<leader>o", "Switch Northstar organization"),
// kilocode_change end
```

Add these exact `CommandMap` entries in the same annotation block:

```ts
northstar_setup: "northstar.setup",
northstar_chat: "northstar.chat",
northstar_mission: "northstar.mission",
northstar_organization: "northstar.organization",
```

The lowercase sequences preserve the approved `Ctrl+X S/C/M/O` navigation (rendered case-insensitively in help copy); the displaced status, compact, and model commands remain available through `Ctrl+X Shift+S/C/M` and their slash/palette entries. Add assertions to `header.test.tsx` that dispatch lowercase Mission and uppercase Model independently.

- [ ] **Step 5: Implement Kilo-owned bootstrap and header**

Register commands and resolved configurable bindings in `header.tsx`:

```tsx
const commandNames = ["northstar.setup", "northstar.chat", "northstar.mission", "northstar.organization"] as const

useBindings(() => ({
  commands: [
    { name: "northstar.setup", title: "Open Setup", category: "Northstar", run: () => route.navigate({ type: "setup", organizationID: workspace.active()?.id }) },
    { name: "northstar.chat", title: "Open Chat", category: "Northstar", run: workspace.openChat },
    { name: "northstar.mission", title: "Open Mission", category: "Northstar", run: () => route.navigate({ type: "cockpit" }) },
    { name: "northstar.organization", title: "Switch organization", category: "Northstar", run: workspace.openOrganizationSelector },
  ],
}))

useBindings(() => ({
  mode: KILO_BASE_MODE,
  bindings: tuiConfig.keybinds.gather("northstar", commandNames),
}))
```

Header clicks dispatch these same command names through `useOpencodeKeymap`, so keyboard and pointer behavior cannot diverge. The test presses the production leader sequence, not command callbacks. Bootstrap routes invalid active organizations to `{ type: "setup", organizationID, repair: true }`.

- [ ] **Step 6: Run render tests and annotation guard**

Run: `cd packages/opencode && bun test test/kilocode/workspace/bootstrap.test.tsx test/kilocode/workspace/header.test.tsx`

Run: `bun run script/check-opencode-annotations.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/opencode/src/kilocode/workspace packages/opencode/src/kilocode/cli/cmd/tui/app.tsx packages/opencode/src/cli/cmd/tui/config/keybind.ts packages/opencode/src/cli/cmd/tui/context/route.tsx packages/opencode/src/cli/cmd/tui/app.tsx packages/opencode/test/kilocode/workspace
git commit -m "feat(tui): open Northstar workspace on startup"
```

### Task 9: Fast project-local organization switching

**Files:**
- Modify: `packages/opencode/src/kilocode/workspace/header.tsx`
- Modify: `packages/opencode/src/kilocode/workspace/context.tsx`
- Modify: `packages/opencode/src/kilocode/setup/view.tsx`
- Test: `packages/opencode/test/kilocode/workspace/switching.test.tsx`

**Interfaces:**
- Consumes `client.organizations.list/select`, SDK instance disposal, sync bootstrap.
- Produces selector rows with validation and active/paused run count; always includes `+ New organization`.

- [ ] **Step 1: Write failing organization-switch tests**

```ts
test("switching refreshes context and opens Mission", async () => {
  const app = await renderWorkspace({ active: "alpha", organizations: [alpha, beta] })
  await app.press("ctrl+x", "o")
  await app.select("Beta")
  expect(app.calls.select).toEqual(["beta"])
  expect(app.calls.dispose).toBe(1)
  expect(app.calls.bootstrap).toBe(1)
  expect(app.route()).toEqual({ type: "cockpit" })
})

test("unsaved Setup draft blocks an immediate switch", async () => {
  const app = await renderWorkspace({ dirty: true })
  await app.selectOrganization("Beta")
  expect(app.frame()).toContain("Discard unsaved Setup changes?")
  expect(app.calls.select).toEqual([])
})
```

- [ ] **Step 2: Run test and verify missing selector behavior**

Run: `cd packages/opencode && bun test test/kilocode/workspace/switching.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement selector and stale-state barrier**

Use `DialogSelect` options with `value: organization.id`, `description: valid ? status : "Repair required"`, and footer active/paused count. Selecting `__new__` navigates to `{ type: "setup" }`. During a real switch, render a loading barrier, select server-side, dispose/rebootstrap, reload registry, then navigate to Cockpit. On any error, retain the old context and show `Could not switch organization: <reason>`.

- [ ] **Step 4: Run tests and commit**

Run: `cd packages/opencode && bun test test/kilocode/workspace/switching.test.tsx test/kilocode/workspace/header.test.tsx`

Expected: PASS.

```bash
git add packages/opencode/src/kilocode/workspace packages/opencode/src/kilocode/setup/view.tsx packages/opencode/test/kilocode/workspace
git commit -m "feat(tui): switch project organizations safely"
```

### Task 10: Organization-bound Chat sessions and CEO default

**Files:**
- Modify: `packages/opencode/src/kilocode/session/index.ts`
- Modify: `packages/opencode/src/session/session.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`
- Modify: `packages/opencode/src/cli/cmd/tui/app.tsx`
- Test: `packages/opencode/test/kilocode/session-organization.test.ts`
- Test: `packages/opencode/test/kilocode/workspace/chat.test.tsx`

**Interfaces:**
- Produces `KiloSession.organizationID(info)`, `KiloSession.forOrganization(items, id, legacy)`, and inherited organization metadata for child sessions.
- Consumes active organization from `OrgWorkspace`/workspace context.

- [ ] **Step 1: Write failing metadata/filter tests**

```ts
test("filters sessions by organization and keeps legacy sessions under legacy", () => {
  const sessions = [session("a", "alpha"), session("b", "beta"), session("old", undefined)]
  expect(KiloSession.forOrganization(sessions, "alpha", false).map((item) => item.id)).toEqual(["a"])
  expect(KiloSession.forOrganization(sessions, "legacy", true).map((item) => item.id)).toEqual(["old"])
})

test("child sessions inherit the parent organization", async () => {
  const parent = await create({ metadata: { northstarOrganizationID: "alpha" } })
  const child = await create({ parentID: parent.id })
  expect(child.metadata?.northstarOrganizationID).toBe("alpha")
})
```

- [ ] **Step 2: Run tests and verify current unscoped behavior**

Run: `cd packages/opencode && bun test test/kilocode/session-organization.test.ts test/kilocode/workspace/chat.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Add Kilo helpers and one shared creation seam**

```ts
export function organizationID(info: Pick<Session.Info, "metadata">): string | undefined {
  const value = info.metadata?.northstarOrganizationID
  return typeof value === "string" ? value : undefined
}

export function forOrganization(items: Session.Info[], id: string, legacy: boolean) {
  return items.filter((item) => organizationID(item) === id || (legacy && organizationID(item) === undefined))
}
```

At `Session.createNext`, derive metadata from explicit input, parent session, or active Kilo organization helper, in that order. Keep this in one `kilocode_change` block. In the session dialog, pass items through `KiloSession.forOrganization` only when a Northstar workspace organization is active.

Opening Chat finds the newest filtered root session; if absent it navigates home. Home submission creates a session with the active organization's CEO name and metadata.

- [ ] **Step 4: Run session/Chat tests and annotation guard**

Run: `cd packages/opencode && bun test test/kilocode/session-organization.test.ts test/kilocode/workspace/chat.test.tsx test/kilocode/session-export/agent.test.ts`

Run: `bun run script/check-opencode-annotations.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/session packages/opencode/src/session/session.ts packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx packages/opencode/src/cli/cmd/tui/app.tsx packages/opencode/test/kilocode
git commit -m "feat(chat): bind sessions to organizations"
```

### Task 11: Chat-to-Mission handoff and Mission empty/completion states

**Files:**
- Create: `packages/opencode/src/kilocode/organization/events.ts`
- Modify: `packages/opencode/src/kilocode/organization/tools.ts`
- Modify: `packages/opencode/src/kilocode/cockpit/view.tsx`
- Modify: `packages/opencode/src/kilocode/cockpit/conversation.ts`
- Modify: `packages/opencode/src/kilocode/kilo-commands.tsx`
- Modify: `packages/opencode/src/kilocode/workspace/shell.tsx`
- Test: `packages/opencode/test/kilocode/workspace/mission-handoff.test.tsx`
- Test: `packages/opencode/test/kilocode/cockpit/mission-completion.test.tsx`

**Interfaces:**
- Produces `OrgWorkspaceEvent.RunStarted` and `.AutonomousStarted` with `{ organizationID, runID, sessionID }`.
- Consumes existing org tools, SDK events, Mission actions, and routes.

- [ ] **Step 1: Write failing handoff/completion tests**

```ts
test("approved autonomous plan opens its Mission run", async () => {
  const app = await renderShell({ route: { type: "session", sessionID: "ses_ceo" }, active: "alpha" })
  await app.publish({ type: "organization.autonomous.started", properties: { organizationID: "alpha", runID: "run_1", sessionID: "ses_ceo" } })
  expect(app.route()).toEqual({ type: "cockpit", runID: "run_1", sessionID: "ses_ceo" })
})

test("completed Mission shows deliverables and return to Chat", async () => {
  const app = await renderMission(completedFixture())
  expect(app.frame()).toContain("Mission complete")
  expect(app.frame()).toContain("Final deliverables")
  expect(app.frame()).toContain("Return to Chat")
})
```

- [ ] **Step 2: Run tests and verify missing event/state failures**

Run: `cd packages/opencode && bun test test/kilocode/workspace/mission-handoff.test.tsx test/kilocode/cockpit/mission-completion.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Define and publish typed organization events**

```ts
export const OrgWorkspaceEvent = {
  RunStarted: BusEvent.define("organization.run.started", Schema.Struct({ organizationID: Schema.String, runID: Schema.String, sessionID: Schema.String })),
  AutonomousStarted: BusEvent.define("organization.autonomous.started", Schema.Struct({ organizationID: Schema.String, runID: Schema.String, sessionID: Schema.String })),
}
```

Publish `RunStarted` after `org_start` persists; publish `AutonomousStarted` only when plan approval flips `auto` and the driver is attached. The workspace shell listens through existing SDK events and navigates only when the event organization matches the active organization.

- [ ] **Step 4: Implement Mission empty and completed states**

When no runs exist, render organization name, department/agent counts, and `Start a mission`; activating it opens Chat with CEO selected. When detail status is completed, render final deliverable paths, total cost, elapsed time, and `Return to Chat`. Preserve active/paused dashboard behavior.

- [ ] **Step 5: Run Mission suites and commit**

Run: `cd packages/opencode && bun test test/kilocode/workspace/mission-handoff.test.tsx test/kilocode/cockpit/mission-completion.test.tsx test/kilocode/cockpit/mission-control-integration.test.tsx test/kilocode/cockpit/mission-control-exit.test.ts`

Expected: PASS.

```bash
git add packages/opencode/src/kilocode/organization/events.ts packages/opencode/src/kilocode/organization/tools.ts packages/opencode/src/kilocode/cockpit packages/opencode/src/kilocode/kilo-commands.tsx packages/opencode/src/kilocode/workspace/shell.tsx packages/opencode/test/kilocode
git commit -m "feat(tui): hand autonomous runs to Mission"
```

### Task 12: Wave-close exit test, branding audit, and changeset

**Files:**
- Create: `packages/opencode/test/kilocode/workspace/northstar-workspace-exit.test.tsx`
- Create: `.changeset/northstar-workspace.md`
- Modify if generated: `packages/kilo-docs/source-links.md`

**Interfaces:**
- Consumes all preceding tasks.
- Produces one end-to-end invariant test and release note.

- [ ] **Step 1: Write the end-to-end exit test**

```ts
test("first launch creates, switches, chats and completes without legacy branding", async () => {
  const app = await launchWorkspace()
  expect(app.frame()).toContain("Create your organization")
  await app.createOrganization(productStudioFixture())
  expect(app.route()).toEqual({ type: "cockpit" })
  await app.createOrganization(researchFixture())
  await app.switchOrganization("Product Studio")
  await app.openChat()
  await app.submitMission("Ship the onboarding workspace")
  await app.approvePlan()
  await app.waitForMissionComplete()
  const frame = app.frame()
  expect(frame).toContain("Mission complete")
  expect(frame).not.toMatch(/Kilo Code|Kilo Gateway|kilo upgrade/)
})
```

- [ ] **Step 2: Run the exit test and fix production defects only**

Run: `cd packages/opencode && bun test test/kilocode/workspace/northstar-workspace-exit.test.tsx`

Expected: PASS. Any failure is fixed in production code with a focused regression assertion; the test's required journey is not weakened.

- [ ] **Step 3: Add the minor changeset**

```md
---
"@ilura/northstar": minor
---

Open Northstar as a multi-organization workspace with guided Setup, managed department knowledge, organization-bound Chat, and direct Mission Control navigation.
```

- [ ] **Step 4: Run the focused full wave**

Run: `cd packages/opencode && bun test test/kilocode/organization test/kilocode/setup test/kilocode/workspace test/kilocode/cockpit test/kilocode/server/organizations.test.ts test/kilocode/server/org-runs-organization.test.ts`

Expected: PASS.

- [ ] **Step 5: Run typecheck and repository guards**

Run: `cd packages/opencode && bun run typecheck`

Run: `bun run script/check-opencode-annotations.ts`

Run: `bun run script/check-opencode-promise-facades.ts`

Run: `bun run script/extract-source-links.ts`

Run: `bun run script/check-md-table-padding.ts`

Expected: every command exits 0; source-link extraction leaves either no diff or the generated documentation diff is committed.

- [ ] **Step 6: Build a single native binary and perform live TUI proof**

Run: `cd packages/opencode && bun run script/build.ts --single --skip-install`

Expected: one platform binary is produced under `dist/@ilura/`; launching it in an empty fixture opens English Setup, finishing Setup opens Mission, `Ctrl+X O` switches organizations, and `Ctrl+X M` returns to Mission from Chat.

- [ ] **Step 7: Commit wave close**

```bash
git add packages/opencode/test/kilocode/workspace/northstar-workspace-exit.test.tsx .changeset/northstar-workspace.md packages/kilo-docs/source-links.md
git commit -m "test(tui): close Northstar workspace journey"
```

## Plan self-review checklist

- Every approved spec section maps to Tasks 1-12.
- Organization identity is carried through paths, HTTP, tools, runs, sessions, knowledge, and UI.
- Legacy projects require no file move or symlink.
- Setup publication and registry/knowledge writes are atomic.
- Provider-free knowledge retrieval is tested.
- Shared OpenCode changes are narrow and annotation-guarded.
- Startup, repair, switching, Chat, autonomous handoff, completion, English copy, and Northstar branding have render or exit coverage.
- Each task has a failing test, focused implementation, passing command, and commit boundary.
