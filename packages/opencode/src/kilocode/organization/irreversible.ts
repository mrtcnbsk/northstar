// kilocode_change - SP1 irreversible action boundary

/**
 * Exact tool IDs whose successful invocation crosses an external or irreversible boundary.
 * Keep this list explicit and reviewable: substring matching creates false positives, while an
 * unknown side-effectful integration must be classified deliberately when it is introduced.
 */
const TOOL_IDS = new Set([
  "asc_submit",
  "npm_publish",
  "release_publish",
  "payment_charge",
  "permission_update",
  "acl_update",
  "hard_delete",
])

export namespace OrgIrreversible {
  export function stage(input: { stage?: string; gate?: "human"; irreversible?: boolean }): boolean {
    return input.irreversible === true || input.gate === "human"
  }

  export function tool(toolID: string): boolean {
    return TOOL_IDS.has(toolID)
  }

  export function touched(toolIDs: Iterable<string>): boolean {
    for (const toolID of toolIDs) {
      if (tool(toolID)) return true
    }
    return false
  }

  export function ids(): readonly string[] {
    return [...TOOL_IDS]
  }
}
