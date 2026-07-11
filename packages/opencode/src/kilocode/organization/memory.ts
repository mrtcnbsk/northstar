// kilocode_change - new file
import path from "path"
import { Memory } from "@kilocode/kilo-memory/memory"

/**
 * Org-scoped shared memory pool (W6.1).
 *
 * REUSE, not reimplementation: this wraps the SAME `Memory.*` facade
 * (`packages/kilo-memory/src/memory.ts`) that session memory uses, pointed at a different,
 * project-local root: `<projectDir>/.kilo/org/memory` instead of the global per-machine
 * session-memory root (`MemoryPaths.root` under the host data dir). Storage (markdown record
 * files + `state.json`/`index.kmem`), the lexical recall scorer, secret redaction, and the
 * `key :: text` record format are all untouched — nothing from `kilo-memory/src/storage`,
 * `kilo-memory/src/recall`, or `kilo-memory/src/capture` is reimplemented here. This module only
 * (a) picks the org root and (b) adds a lightweight `dept` tag on top.
 *
 * Because it is the same `{root}`-parameterized engine, recall stays PURE LEXICAL (keyword
 * scoring, no embeddings, no API key) exactly like session memory.
 *
 * Isolation: the org root lives under `.kilo/org/memory`, which session memory never resolves to
 * (session memory roots live under a per-machine host data dir keyed by a hash of the project
 * path, see `MemoryPaths.root`). Nothing in this module ever touches any root other than the one
 * `root()` computes, so writing org memory cannot reach the session-memory `project.md`.
 *
 * Dept tagging: a `dept`, when provided, is encoded as a `[dept::<name>]` marker PREPENDED to the
 * record's stored text before it is handed to `Memory.remember` - so it rides inside the same
 * `key :: text` line Memory already writes, with no schema/storage change. `recall({ dept })`
 * narrows by checking each returned hit's text for that exact marker: a deterministic post-filter
 * over `Memory.recall`'s hits, not a change to the lexical scorer itself. The marker's own tokens
 * ("dept", the dept name) also land in the lexical index as a side effect, so a query that
 * mentions the dept name will tend to already rank tagged records higher even without the
 * explicit `dept` filter - but `dept` filtering here is exact-marker-match, not score-based.
 */
export namespace OrgMemory {
  export function root(projectDir: string): string {
    return path.join(projectDir, ".kilo", "org", "memory")
  }

  function marker(dept: string) {
    return `[dept::${dept}]`
  }

  function tag(dept: string | undefined, text: string) {
    return dept ? `${marker(dept)} ${text}` : text
  }

  export type SaveInput = {
    text: string
    dept?: string
    key?: string
  }

  export type RecallInput = {
    query: string
    dept?: string
    limit?: number
  }

  /** Save a lesson/fact to the org pool. Lazily creates/owns `.kilo/org/memory` on first write -
   * `Memory.enable` is an idempotent upsert (safe to call on every save), and it only ever touches
   * the org `root()` computed above, never the session-memory root. */
  export async function save(projectDir: string, input: SaveInput) {
    const orgRoot = root(projectDir)
    await Memory.enable({ root: orgRoot })
    return Memory.remember({ root: orgRoot, text: tag(input.dept, input.text), key: input.key })
  }

  /** Lexical recall over the org pool, optionally narrowed to a `dept`. Never throws on an empty
   * or never-written pool: `Memory.recall` against a root with no `state.json` yet returns a
   * disabled-state shape with no `hits` field, which is normalized to `[]` here rather than
   * accessed directly. */
  export async function recall(projectDir: string, input: RecallInput) {
    const orgRoot = root(projectDir)
    const raw = await Memory.recall({ root: orgRoot, query: input.query })
    const hits = "hits" in raw ? (raw.hits ?? []) : []
    const dept = input.dept
    const scoped = dept ? hits.filter((hit) => hit.text.includes(marker(dept))) : hits
    const limit = input.limit
    const limited = typeof limit === "number" && limit >= 0 ? scoped.slice(0, limit) : scoped
    return {
      root: orgRoot,
      hits: limited,
      files: [...new Set(limited.map((hit) => hit.source))],
      topics: [...new Set(limited.flatMap((hit) => (hit.topics?.length ? hit.topics : [hit.kind])))],
    }
  }
}
