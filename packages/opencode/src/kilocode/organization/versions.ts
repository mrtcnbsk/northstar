// kilocode_change - new file
import { createHash } from "node:crypto"
import path from "path"
import { createTwoFilesPatch } from "diff"
import { Filesystem } from "../../util/filesystem"
import { OrgArtifacts } from "./artifacts"
import { OrgState } from "./state"

/**
 * Content-addressed snapshot store for stage deliverables (W8.5).
 *
 * `Stage.reviseBaseline` (see state.ts) is only a sha256 STRING captured at revise-decision time —
 * it lets the runner detect whether a deliverable changed, but retains no prior CONTENT. The chief
 * overwrites the live `.md` file in place (via the generic write tool), so once a deliverable is
 * revised or rolled back, its previous bytes are gone unless something else preserved them. This
 * module is that something else: every `snapshot()` call copies the live deliverable's CURRENT
 * bytes into a content-addressed sidecar store, keyed by `(runID, stage, sha256(content))`, and
 * appends an ordered manifest entry. `rollback()` is built on top of it and is NON-DESTRUCTIVE: it
 * snapshots whatever is live before overwriting, so the replaced content is itself recoverable and
 * roll-forward is always possible.
 *
 * Storage layout (sibling of `deliverables/`, see OrgArtifacts):
 *   .kilo/org/runs/<runID>/deliverables.versions/<stage>/<sha256>.md       (content, one file per version)
 *   .kilo/org/runs/<runID>/deliverables.versions/<stage>/manifest.json    (ordered Array<VersionEntry>)
 *
 * Single-writer discipline: org tools are CEO-serial (same assumption as `OrgAudit.append`), so the
 * manifest's read-modify-write is safe without file locking.
 *
 * No circular import: `runner.ts` imports this module (for its best-effort snapshot hooks), so this
 * module must never import `runner.ts`. It computes its own sha256 (mirroring rag.ts's `fileHash`)
 * rather than reuse runner.ts's private `deliverableHash` helper.
 */
export namespace OrgVersions {
  export type VersionEntry = { ts: string; hash: string; path: string }

  export function versionsDir(projectDir: string, runID: string, stage: string): string {
    return path.join(OrgState.runDir(projectDir, runID), "deliverables.versions", stage)
  }

  export function versionPath(projectDir: string, runID: string, stage: string, hash: string): string {
    return path.join(versionsDir(projectDir, runID, stage), `${hash}.md`)
  }

  export function manifestPath(projectDir: string, runID: string, stage: string): string {
    return path.join(versionsDir(projectDir, runID, stage), "manifest.json")
  }

  async function readManifest(projectDir: string, runID: string, stage: string): Promise<VersionEntry[]> {
    const file = manifestPath(projectDir, runID, stage)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
        throw new Error(`Failed to read version manifest ${file}: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        })
      })
    if (text === undefined) return []
    try {
      return JSON.parse(text) as VersionEntry[]
    } catch (e) {
      throw new Error(`Failed to parse version manifest ${file}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      })
    }
  }

  /** Read-modify-append without locking: see the module doc comment for the single-writer rationale. */
  async function appendManifest(
    projectDir: string,
    runID: string,
    stage: string,
    entry: VersionEntry,
  ): Promise<VersionEntry[]> {
    const entries = await readManifest(projectDir, runID, stage)
    entries.push(entry)
    await Filesystem.write(manifestPath(projectDir, runID, stage), JSON.stringify(entries, null, 2))
    return entries
  }

  async function readVersionOrThrow(projectDir: string, runID: string, stage: string, hash: string): Promise<string> {
    const file = versionPath(projectDir, runID, stage, hash)
    return await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new Error(`Unknown deliverable version: no snapshot for hash "${hash}" at ${file}`)
        }
        throw new Error(`Failed to read deliverable version ${file}: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        })
      })
  }

  /**
   * Snapshots the LIVE deliverable's current content. Returns `undefined` when there is nothing to
   * snapshot (deliverable not yet produced - ENOENT). Idempotent: re-snapshotting identical content
   * (hash + manifest entry both already present) is a no-op that returns the existing entry rather
   * than duplicating it.
   */
  export async function snapshot(
    projectDir: string,
    runID: string,
    stage: string,
  ): Promise<{ hash: string; path: string } | undefined> {
    const liveFile = OrgArtifacts.deliverablePath(projectDir, runID, stage)
    const text = await Bun.file(liveFile)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
        throw new Error(`Failed to read deliverable ${liveFile}: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        })
      })
    if (text === undefined) return undefined

    const hash = createHash("sha256").update(text).digest("hex")
    const file = versionPath(projectDir, runID, stage, hash)
    const entries = await readManifest(projectDir, runID, stage)
    const alreadyRecorded = entries.some((e) => e.hash === hash)
    const contentExists = await Bun.file(file).exists()

    if (alreadyRecorded && contentExists) return { hash, path: file }
    if (!contentExists) await Filesystem.write(file, text)
    if (!alreadyRecorded) await appendManifest(projectDir, runID, stage, { ts: new Date().toISOString(), hash, path: file })
    return { hash, path: file }
  }

  /** The per-stage manifest, in append order (oldest first). Empty array when nothing was ever snapshotted. */
  export async function list(projectDir: string, runID: string, stage: string): Promise<VersionEntry[]> {
    return readManifest(projectDir, runID, stage)
  }

  /** Unified diff (via the `diff` package) between two previously snapshotted versions. */
  export async function diff(
    projectDir: string,
    runID: string,
    stage: string,
    hashA: string,
    hashB: string,
  ): Promise<string> {
    const [textA, textB] = await Promise.all([
      readVersionOrThrow(projectDir, runID, stage, hashA),
      readVersionOrThrow(projectDir, runID, stage, hashB),
    ])
    return createTwoFilesPatch(hashA, hashB, textA, textB)
  }

  /**
   * NON-DESTRUCTIVE rollback: snapshots whatever is currently live FIRST (so the content being
   * replaced is preserved and roll-forward stays possible), then overwrites the live deliverable
   * with the requested version's exact bytes. Throws a clear error if `hash` was never snapshotted.
   */
  export async function rollback(
    projectDir: string,
    runID: string,
    stage: string,
    hash: string,
  ): Promise<{ restoredHash: string }> {
    const targetText = await readVersionOrThrow(projectDir, runID, stage, hash)
    await snapshot(projectDir, runID, stage)
    await Filesystem.write(OrgArtifacts.deliverablePath(projectDir, runID, stage), targetText)
    return { restoredHash: hash }
  }
}
