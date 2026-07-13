// kilocode_change - project-local Northstar organization registry and storage scope
import path from "path"
import { AsyncLocalStorage } from "node:async_hooks"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import z from "zod"

export namespace OrgWorkspace {
  const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

  export const Entry = z.object({
    id: z.string().regex(SAFE_ID),
    name: z.string().trim().min(1),
    layout: z.enum(["legacy", "managed"]),
    root: z.string().min(1),
  })
  export type Entry = z.output<typeof Entry>

  export const Registry = z
    .object({
      version: z.literal(1),
      active: z.string().regex(SAFE_ID).optional(),
      organizations: z.array(Entry),
    })
    .superRefine((value, ctx) => {
      if (!value.active) return
      if (value.organizations.some((entry) => entry.id === value.active)) return
      ctx.addIssue({ code: "custom", message: `Active organization '${value.active}' is not registered`, path: ["active"] })
    })
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

  export type Context = {
    projectDir: string
    entry: Entry
    paths: Paths
  }

  const scope = new AsyncLocalStorage<Context>()

  function registryFile(dir: string) {
    return path.join(dir, ".kilo", "organizations.json")
  }

  function stagingRoot(dir: string) {
    return path.join(dir, ".kilo", "organizations", ".staging")
  }

  function stagingDir(dir: string, id: string) {
    assertID(id)
    return path.join(stagingRoot(dir), id)
  }

  function stageFile(dir: string, id: string) {
    return path.join(stagingDir(dir, id), ".northstar-stage.json")
  }

  function assertID(id: string) {
    if (SAFE_ID.test(id)) return
    throw new Error("Expected a safe organization id")
  }

  async function exists(file: string) {
    return stat(file)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      })
  }

  async function atomic(file: string, value: unknown) {
    const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(temp, JSON.stringify(value, null, 2) + "\n")
    await rename(temp, file)
  }

  function slug(name: string) {
    return name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  }

  export function paths(dir: string, entry: Entry): Paths {
    assertID(entry.id)
    if (entry.layout === "legacy" && entry.root !== ".") throw new Error("Expected the legacy organization root")
    const managedRoot = entry.root === `organizations/${entry.id}`
    const stagedRoot = entry.root === `organizations/.staging/${entry.id}`
    if (entry.layout === "managed" && !managedRoot && !stagedRoot) {
      throw new Error("Expected a safe organization root")
    }

    const root = entry.layout === "legacy" ? path.join(dir, ".kilo") : path.join(dir, ".kilo", entry.root)
    if (entry.layout === "legacy") {
      return {
        root,
        organization: path.join(root, "organization.jsonc"),
        agents: path.join(root, "agent"),
        knowledge: path.join(root, "knowledge"),
        runs: path.join(root, "org", "runs"),
        memory: path.join(root, "org", "memory"),
        lessons: path.join(root, "org", "lessons.md"),
        rag: path.join(root, "org", "rag"),
      }
    }
    return {
      root,
      organization: path.join(root, "organization.jsonc"),
      agents: path.join(root, "agents"),
      knowledge: path.join(root, "knowledge"),
      runs: path.join(root, "runs"),
      memory: path.join(root, "memory"),
      lessons: path.join(root, "lessons.md"),
      rag: path.join(root, "rag"),
    }
  }

  function context(dir: string, entry: Entry): Context {
    return { projectDir: dir, entry, paths: paths(dir, entry) }
  }

  async function write(dir: string, value: Registry) {
    await atomic(registryFile(dir), Registry.parse(value))
  }

  export async function list(dir: string): Promise<Registry> {
    const file = Bun.file(registryFile(dir))
    if (await file.exists()) return Registry.parse(await file.json())

    const legacy = await exists(path.join(dir, ".kilo", "organization.jsonc"))
    const value: Registry = legacy
      ? {
          version: 1,
          active: "legacy",
          organizations: [{ id: "legacy", name: "Legacy organization", layout: "legacy", root: "." }],
        }
      : { version: 1, organizations: [] }
    if (legacy) await write(dir, value)
    return value
  }

  export async function stage(dir: string, name: string): Promise<Context> {
    const id = slug(name)
    if (!id) throw new Error("Organization name must contain a letter or number")
    const registry = await list(dir)
    if (registry.organizations.some((entry) => entry.id === id) || (await exists(stageFile(dir, id)))) {
      throw new Error(`Organization '${id}' already exists`)
    }

    const entry = Entry.parse({
      id,
      name: name.trim(),
      layout: "managed",
      root: `organizations/.staging/${id}`,
    })
    const result = context(dir, entry)
    await mkdir(result.paths.root, { recursive: true })
    await atomic(stageFile(dir, id), entry)
    return result
  }

  export async function draft(dir: string, id: string): Promise<Context> {
    assertID(id)
    const file = Bun.file(stageFile(dir, id))
    if (!(await file.exists())) throw new Error(`Unknown organization draft '${id}'`)
    return context(dir, Entry.parse(await file.json()))
  }

  export async function drafts(dir: string): Promise<Context[]> {
    const entries = await readdir(stagingRoot(dir), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const values = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => draft(dir, entry.name).catch(() => undefined)),
    )
    return values.filter((value): value is Context => value !== undefined)
  }

  export async function discard(dir: string, id: string) {
    await draft(dir, id)
    await rm(stagingDir(dir, id), { recursive: true, force: true })
  }

  export async function resolve(dir: string, id?: string): Promise<Context> {
    const registry = await list(dir)
    const selected = id ?? registry.active
    const entry = registry.organizations.find((candidate) => candidate.id === selected)
    if (!entry) throw new Error(selected ? `Unknown organization '${selected}'` : "No active organization")
    return context(dir, entry)
  }

  export async function active(dir: string): Promise<Context | undefined> {
    const registry = await list(dir)
    if (!registry.active) return
    return resolve(dir, registry.active)
  }

  export async function select(dir: string, id: string): Promise<Context> {
    const registry = await list(dir)
    const entry = registry.organizations.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`Unknown organization '${id}'`)
    await write(dir, { ...registry, active: id })
    return context(dir, entry)
  }

  export async function publish(dir: string, id: string): Promise<Context> {
    const staged = await draft(dir, id)
    const entry = Entry.parse({ ...staged.entry, root: `organizations/${id}` })
    const target = paths(dir, entry).root
    if (await exists(target)) throw new Error(`Organization '${id}' already exists`)

    await rename(staged.paths.root, target)
    try {
      const registry = await list(dir)
      if (registry.organizations.some((candidate) => candidate.id === id)) {
        throw new Error(`Organization '${id}' already exists`)
      }
      await write(dir, { version: 1, active: id, organizations: [...registry.organizations, entry] })
    } catch (error) {
      await rename(target, staged.paths.root)
      throw error
    }
    await rm(path.join(target, ".northstar-stage.json"), { force: true })
    return context(dir, entry)
  }

  export function run<A>(ctx: Context, fn: () => A): A {
    return scope.run(ctx, fn)
  }

  export function current(dir: string): Context | undefined {
    const value = scope.getStore()
    return value?.projectDir === dir ? value : undefined
  }
}
