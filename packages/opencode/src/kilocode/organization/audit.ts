// kilocode_change - new file
import nodePath from "path"
import z from "zod"
import { Filesystem } from "../../util/filesystem"
import { OrgState } from "./state"

/**
 * Durable, append-only audit trail of gate decisions for an org run, written alongside
 * state.json. Same single-writer assumption as OrgState.update: org tools are CEO-only and a
 * single CEO session calls them serially, so a read-modify-append without locking is safe.
 */
export namespace OrgAudit {
  export const Entry = z.object({
    ts: z.string(),
    stage: z.string(),
    decision: z.string(),
    note: z.string().optional(),
    /** sha256 of the deliverable at decision time; omitted when the deliverable was unreadable. */
    deliverableHash: z.string().optional(),
  })
  export type Entry = z.output<typeof Entry>

  export function path(projectDir: string, runID: string): string {
    return nodePath.join(OrgState.runDir(projectDir, runID), "approvals.json")
  }

  export async function read(projectDir: string, runID: string): Promise<Entry[]> {
    const file = path(projectDir, runID)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
        throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    if (text === undefined) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new Error(`Failed to parse ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    return z.array(Entry).parse(parsed)
  }

  /** Read-modify-append without locking: see the module doc comment for the single-writer rationale. */
  export async function append(projectDir: string, runID: string, entry: Entry): Promise<Entry[]> {
    const entries = await read(projectDir, runID)
    entries.push(entry)
    await Filesystem.write(path(projectDir, runID), JSON.stringify(entries, null, 2))
    return entries
  }
}
