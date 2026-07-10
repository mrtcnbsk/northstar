// kilocode_change - new file
import path from "path"
import { OrgState } from "./state"

export namespace OrgArtifacts {
  export const MIN_LENGTH = 50

  export function deliverablesDir(projectDir: string, runID: string): string {
    return path.join(OrgState.runDir(projectDir, runID), "deliverables")
  }

  export function deliverablePath(projectDir: string, runID: string, stage: string): string {
    return path.join(deliverablesDir(projectDir, runID), `${stage}.md`)
  }

  export type Validation = { ok: true } | { ok: false; reason: string }

  export async function validate(projectDir: string, runID: string, stage: string): Promise<Validation> {
    const file = deliverablePath(projectDir, runID, stage)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
        throw new Error(`Failed to read deliverable ${file}: ${e instanceof Error ? e.message : String(e)}`, {
          cause: e,
        })
      })
    if (text === undefined) return { ok: false, reason: `deliverable not found at ${file}` }
    if (text.trim().length < MIN_LENGTH) {
      return {
        ok: false,
        reason: `deliverable at ${file} is too short (${text.trim().length} chars, need >= ${MIN_LENGTH})`,
      }
    }
    return { ok: true }
  }
}
