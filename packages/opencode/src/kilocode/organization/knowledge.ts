// kilocode_change - Northstar-managed shared and department knowledge
import path from "path"
import { mkdir, realpath, rename, rm, stat } from "node:fs/promises"
import z from "zod"
import { OrgWorkspace } from "./workspace"

export namespace OrgKnowledge {
  const SAFE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

  export const Scope = z.discriminatedUnion("type", [
    z.object({ type: z.literal("shared") }),
    z.object({ type: z.literal("department"), departmentID: z.string().regex(SAFE) }),
  ])
  export type Scope = z.output<typeof Scope>

  export const Item = z.object({
    id: z.string().min(1),
    source: z.string().min(1),
    managed: z.string().min(1),
    scope: Scope,
    hash: z.string().length(64),
    size: z.number().int().nonnegative(),
    importedAt: z.string(),
  })
  export type Item = z.output<typeof Item>

  export const Manifest = z.object({ version: z.literal(1), items: z.array(Item) })
  export type Manifest = z.output<typeof Manifest>

  const Document = z.object({
    id: z.string().min(1),
    managed: z.string().min(1),
    scope: Scope,
    tokens: z.array(z.string()),
    excerpt: z.string(),
  })
  type Document = z.output<typeof Document>

  const Index = z.object({ version: z.literal(1), documents: z.array(Document) })
  type Index = z.output<typeof Index>

  export type ImportStatus = "indexed" | "unchanged"
  export type ImportResult = { files: Array<{ source: string; status: ImportStatus; item: Item }> }
  export type SearchResult = Document & { score: number }
  export type ImportOptions = {
    semantic?: (input: { context: OrgWorkspace.Context; items: Item[] }) => Promise<void>
  }

  function manifestPath(ctx: OrgWorkspace.Context) {
    return path.join(ctx.paths.knowledge, "manifest.json")
  }

  function indexPath(ctx: OrgWorkspace.Context) {
    return path.join(ctx.paths.knowledge, "index.json")
  }

  async function exists(file: string) {
    return stat(file)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      })
  }

  function inside(root: string, file: string) {
    const relative = path.relative(root, file)
    return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
  }

  function normalized(file: string) {
    return file.split(path.sep).join("/")
  }

  function safeName(file: string) {
    const value = path.basename(file).normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+/, "")
    return value || "knowledge.txt"
  }

  function scopeKey(scope: Scope) {
    return scope.type === "shared" ? "shared" : `department:${scope.departmentID}`
  }

  function tokens(text: string) {
    return [
      ...new Set(
        text
          .toLowerCase()
          .normalize("NFKC")
          .match(/[\p{L}\p{N}]+/gu)
          ?.filter((token) => token.length > 1) ?? [],
      ),
    ]
  }

  async function readManifest(ctx: OrgWorkspace.Context): Promise<Manifest> {
    const file = Bun.file(manifestPath(ctx))
    return (await file.exists()) ? Manifest.parse(await file.json()) : { version: 1, items: [] }
  }

  async function readIndex(ctx: OrgWorkspace.Context): Promise<Index> {
    const file = Bun.file(indexPath(ctx))
    return (await file.exists()) ? Index.parse(await file.json()) : { version: 1, documents: [] }
  }

  async function commit(ctx: OrgWorkspace.Context, manifest: Manifest, index: Index) {
    const transaction = `${process.pid}-${crypto.randomUUID()}`
    const entries = [
      {
        file: manifestPath(ctx),
        temp: `${manifestPath(ctx)}.tmp-${transaction}`,
        backup: `${manifestPath(ctx)}.bak-${transaction}`,
        value: manifest,
      },
      {
        file: indexPath(ctx),
        temp: `${indexPath(ctx)}.tmp-${transaction}`,
        backup: `${indexPath(ctx)}.bak-${transaction}`,
        value: index,
      },
    ]
    await mkdir(ctx.paths.knowledge, { recursive: true })
    await Promise.all(entries.map((entry) => Bun.write(entry.temp, JSON.stringify(entry.value, null, 2) + "\n")))
    const moved: typeof entries = []
    const installed: typeof entries = []
    try {
      for (const entry of entries) {
        if (!(await exists(entry.file))) continue
        await rename(entry.file, entry.backup)
        moved.push(entry)
      }
      for (const entry of entries) {
        await rename(entry.temp, entry.file)
        installed.push(entry)
      }
    } catch (error) {
      await Promise.all(installed.map((entry) => rm(entry.file, { force: true })))
      for (const entry of moved.reverse()) await rename(entry.backup, entry.file)
      await Promise.all(entries.map((entry) => rm(entry.temp, { force: true })))
      throw error
    }
    await Promise.all(moved.map((entry) => rm(entry.backup, { force: true }).catch(() => undefined)))
  }

  async function source(ctx: OrgWorkspace.Context, input: string) {
    const project = await realpath(ctx.projectDir)
    const requested = path.resolve(project, input)
    if (!inside(project, requested)) throw new Error("Knowledge files must be inside the workspace")
    const file = await realpath(requested)
    if (!inside(project, file)) throw new Error("Knowledge files must be inside the workspace")
    const info = await stat(file)
    if (!info.isFile()) throw new Error(`Knowledge source is not a file: ${input}`)
    const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
    if (bytes.includes(0)) throw new Error("Only text knowledge files are supported")
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return {
        source: normalized(path.relative(project, requested)),
        bytes,
        text,
        hash: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      }
    } catch {
      throw new Error("Only text knowledge files are supported")
    }
  }

  export async function manifest(ctx: OrgWorkspace.Context) {
    return readManifest(ctx)
  }

  export async function importFiles(
    ctx: OrgWorkspace.Context,
    input: { sources: string[]; scope: Scope },
    options: ImportOptions = {},
  ): Promise<ImportResult> {
    const scope = Scope.parse(input.scope)
    const sources = await Promise.all(input.sources.map((file) => source(ctx, file)))
    const unique = new Set<string>()
    for (const data of sources) {
      if (unique.has(data.source)) throw new Error(`Duplicate knowledge source: ${data.source}`)
      unique.add(data.source)
    }
    const beforeManifest = await readManifest(ctx)
    const beforeIndex = await readIndex(ctx)
    const created = new Set<string>()
    const replaced = new Set<string>()
    const results: ImportResult["files"] = []
    const nextManifest: Manifest = { version: 1, items: [...beforeManifest.items] }
    const nextIndex: Index = { version: 1, documents: [...beforeIndex.documents] }

    try {
      for (const data of sources) {
        const id = `${scopeKey(scope)}:${data.source}`
        const prior = nextManifest.items.find((item) => item.id === id)
        const priorDocument = nextIndex.documents.find((document) => document.id === id)
        if (prior?.hash === data.hash && priorDocument && (await exists(path.join(ctx.paths.knowledge, prior.managed)))) {
          results.push({ source: data.source, status: "unchanged", item: prior })
          continue
        }

        const folder = scope.type === "shared" ? "shared" : path.posix.join("departments", scope.departmentID)
        const managed = path.posix.join(folder, `${data.hash}-${safeName(data.source)}`)
        const target = path.join(ctx.paths.knowledge, ...managed.split("/"))
        await mkdir(path.dirname(target), { recursive: true })
        if (!(await exists(target))) {
          const temp = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
          await Bun.write(temp, data.bytes)
          await rename(temp, target)
          created.add(target)
        }

        const item = Item.parse({
          id,
          source: data.source,
          managed,
          scope,
          hash: data.hash,
          size: data.bytes.byteLength,
          importedAt: new Date().toISOString(),
        })
        const document = Document.parse({
          id,
          managed,
          scope,
          tokens: tokens(data.text),
          excerpt: data.text.slice(0, 500),
        })
        nextManifest.items = [...nextManifest.items.filter((value) => value.id !== id), item]
        nextIndex.documents = [...nextIndex.documents.filter((value) => value.id !== id), document]
        if (prior && prior.managed !== managed) replaced.add(path.join(ctx.paths.knowledge, prior.managed))
        results.push({ source: data.source, status: "indexed", item })
      }

      await commit(ctx, Manifest.parse(nextManifest), Index.parse(nextIndex))
    } catch (error) {
      await Promise.all([...created].map((file) => rm(file, { force: true })))
      throw error
    }

    const retained = new Set(nextManifest.items.map((item) => path.join(ctx.paths.knowledge, item.managed)))
    await Promise.all([...replaced].filter((file) => !retained.has(file)).map((file) => rm(file, { force: true })))
    const indexed = results.filter((result) => result.status === "indexed").map((result) => result.item)
    if (indexed.length > 0 && options.semantic) {
      await options.semantic({ context: ctx, items: indexed }).catch(() => undefined)
    }
    return { files: results }
  }

  export async function search(
    ctx: OrgWorkspace.Context,
    input: { query: string; departmentID?: string; limit?: number },
  ): Promise<SearchResult[]> {
    if (input.departmentID && !SAFE.test(input.departmentID)) throw new Error("Expected a safe department id")
    const query = tokens(input.query)
    if (query.length === 0) return []
    const index = await readIndex(ctx)
    return index.documents
      .filter((document) => document.scope.type === "shared" || document.scope.departmentID === input.departmentID)
      .map((document) => ({
        ...document,
        score: query.filter((token) => document.tokens.includes(token)).length / query.length,
      }))
      .filter((document) => document.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, input.limit ?? 8)
  }
}
