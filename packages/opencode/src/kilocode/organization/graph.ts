// kilocode_change - new file
import { OrgSchema } from "./schema"

/**
 * Reverse dependency index over the org pipeline. Where OrgSchema.resolveRequires walks
 * "upstream" (a stage's prerequisites), OrgGraph walks "downstream" (a stage's consumers) - the
 * artifacts that a change to a given stage can invalidate. Pure - no I/O, mirrors schema.ts's
 * pure graph helpers (isAncestor, findCycle).
 */
export namespace OrgGraph {
  /**
   * The INVERSE of resolveRequires: for each pipeline stage, the stages that DIRECTLY require it
   * (its consumers). Every pipeline stage is present as a key, with an empty array when nothing
   * depends on it. Pure function - no I/O.
   */
  export function dependents(org: OrgSchema.Organization): Record<string, string[]> {
    const requires = OrgSchema.resolveRequires(org)
    const result: Record<string, string[]> = {}
    for (const { stage } of org.pipeline) result[stage] = []
    for (const [stage, deps] of Object.entries(requires)) {
      for (const dep of deps) {
        // dep may be a dangling/unknown reference in an unvalidated org; only record it against
        // a key that actually exists in the pipeline (validate() reports dangling refs separately).
        if (Object.hasOwn(result, dep)) result[dep].push(stage)
      }
    }
    return result
  }

  /**
   * The transitive closure of `dependents` starting from `stage`: every stage that directly or
   * indirectly requires `stage`, i.e. the set of downstream stages a change to `stage` invalidates.
   * Excludes `stage` itself. Deduped, returned in `org.pipeline` order for determinism.
   * Pure function - no I/O.
   */
  export function impactRadius(org: OrgSchema.Organization, stage: string): string[] {
    const graph = dependents(org)
    const visited = new Set<string>()
    const stack = [...(graph[stage] ?? [])]
    while (stack.length) {
      const node = stack.pop()!
      if (visited.has(node)) continue
      visited.add(node)
      stack.push(...(graph[node] ?? []))
    }
    return org.pipeline.filter((p) => visited.has(p.stage)).map((p) => p.stage)
  }
}
