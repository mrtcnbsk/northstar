// kilocode_change - new file
import path from "path"
import z from "zod"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"

export namespace OrgSchema {
  export const Department = z.object({
    chief: z.string().min(1),
    workers: z.array(z.string().min(1)).min(1),
  })

  /** Declarative skip condition (v1, no expression DSL - see decision #4 in the wave-4 plan). */
  export const When = z.union([
    z.object({ mode: z.string().min(1) }),
    z.object({ stage: z.string().min(1), decision: z.enum(["approve", "no-go", "revise"]) }),
  ])
  export type When = z.output<typeof When>

  export const Stage = z.object({
    stage: z.string().min(1),
    gate: z.enum(["human"]).optional(),
    haltOn: z.enum(["no-go"]).optional(),
    /** Per-stage budget ceiling override (USD), falls back to the org's resolved stage budget. */
    budget: z.number().nonnegative().optional(),
    /** Stage names this stage depends on. Absent defaults to [previousStage] (see resolveRequires); explicit [] is an intentional root. */
    requires: z.array(z.string().min(1)).optional(),
    /** Per-stage wall-clock timeout in ms (poll-checked by the runner, not a background timer). */
    timeoutMs: z.number().int().positive().optional(),
    /** Declarative skip condition; a false `when` marks the stage "skipped" instead of running it. */
    when: When.optional(),
  })

  /** Budget config (USD, except retries which is an integer count). All fields optional; see resolveBudget for defaults. */
  export const Budget = z.object({
    run: z.number().nonnegative().optional(),
    stage: z.number().nonnegative().optional(),
    escalationThreshold: z.number().nonnegative().optional(),
    retries: z.number().int().nonnegative().optional(),
  })

  export const Organization = z.object({
    ceo: z.string().min(1),
    departments: z.record(z.string(), Department),
    shared: z.array(z.string().min(1)).default([]),
    pipeline: z.array(Stage).min(1),
    budget: Budget.optional(),
    /** Max stages the runner will run concurrently per advance() batch. Default 1 (sequential, current behavior). */
    maxConcurrency: z.number().int().positive().optional(),
    /** Opt-in toolpacks (see `kilocode/tool/toolpacks.ts`) whose tools become visible to every
     * agent in this org. Generic - not specific to any one pack (e.g. "apple-delivery"). */
    toolpacks: z.array(z.string()).default([]),
  })
  export type Organization = z.output<typeof Organization>

  export type ResolvedBudget = {
    run: number
    stage: number
    escalationThreshold: number
    retries: number
  }

  /** Owner-approved defaults (USD; retries is an integer count). */
  const BUDGET_DEFAULTS: ResolvedBudget = {
    run: 50,
    stage: 15,
    escalationThreshold: 10,
    retries: 2,
  }

  export function parse(input: unknown): Organization {
    return Organization.parse(input)
  }

  /** Fills any absent budget field with its owner-approved default. Pure function. */
  export function resolveBudget(org: Organization): ResolvedBudget {
    return {
      run: org.budget?.run ?? BUDGET_DEFAULTS.run,
      stage: org.budget?.stage ?? BUDGET_DEFAULTS.stage,
      escalationThreshold: org.budget?.escalationThreshold ?? BUDGET_DEFAULTS.escalationThreshold,
      retries: org.budget?.retries ?? BUDGET_DEFAULTS.retries,
    }
  }

  /**
   * Soft, non-blocking budget sanity checks (e.g. stage > run). Callers such as
   * loadOrganization may log these but must NOT throw on them - unlike validate(),
   * which blocks load. Returns [] when the resolved budget is sane.
   */
  export function budgetWarnings(org: Organization): string[] {
    const warnings: string[] = []
    const resolved = resolveBudget(org)
    if (resolved.stage > resolved.run) {
      warnings.push(`budget.stage (${resolved.stage}) is greater than budget.run (${resolved.run})`)
    }
    if (resolved.escalationThreshold > resolved.run) {
      warnings.push(
        `budget.escalationThreshold (${resolved.escalationThreshold}) is greater than budget.run (${resolved.run})`,
      )
    }
    return warnings
  }

  /**
   * Resolves each pipeline stage's `requires` list. Pure function - no validation, no I/O.
   * - `requires` ABSENT: defaults to `[previousStageName]` (the immediately-preceding pipeline
   *   entry); the FIRST stage defaults to `[]`.
   * - `requires` explicit `[]`: stays `[]` (an intentional root, not defaulted).
   * - `requires` explicit non-empty list: used verbatim.
   */
  export function resolveRequires(org: Organization): Record<string, string[]> {
    const resolved: Record<string, string[]> = {}
    org.pipeline.forEach((entry, i) => {
      if (entry.requires !== undefined) {
        resolved[entry.stage] = entry.requires
      } else {
        resolved[entry.stage] = i === 0 ? [] : [org.pipeline[i - 1].stage]
      }
    })
    return resolved
  }

  /** Agent names that would break permission-rule ordering or wildcard semantics. */
  function invalidName(name: string): string | undefined {
    if (name === "*") return `agent name "*" is not allowed (wildcard collides with permission patterns)`
    if (/^\d+$/.test(name))
      return `agent name "${name}" is not allowed (integer-like keys break permission rule ordering)`
    return undefined
  }

  /** Structural validation beyond shape: stage references, role conflicts, name rules. */
  export function validate(org: Organization): string[] {
    const errors: string[] = []
    const names = new Set<string>([org.ceo, ...org.shared])
    for (const dept of Object.values(org.departments)) {
      names.add(dept.chief)
      for (const worker of dept.workers) names.add(worker)
    }
    for (const name of names) {
      const problem = invalidName(name)
      if (problem) errors.push(problem)
    }
    for (const key of Object.keys(org.departments)) {
      if (key === "." || key.includes("..") || key.includes("/") || key.includes("\\")) {
        errors.push(`department key "${key}" is not a safe path segment (no "/", "\\", "..", or ".")`)
      }
    }
    const seen = new Set<string>()
    for (const { stage } of org.pipeline) {
      if (seen.has(stage)) errors.push(`duplicate pipeline stage "${stage}"`)
      seen.add(stage)
      if (!Object.hasOwn(org.departments, stage))
        errors.push(`pipeline stage "${stage}" has no matching department`)
    }
    const chiefs = new Set(Object.values(org.departments).map((d) => d.chief))
    const workers = new Set(Object.values(org.departments).flatMap((d) => d.workers))
    for (const chief of chiefs) {
      if (workers.has(chief)) errors.push(`agent "${chief}" is both a chief and a worker (role conflict)`)
    }
    if (chiefs.has(org.ceo) || workers.has(org.ceo)) {
      errors.push(`ceo agent "${org.ceo}" cannot also be a chief or worker`)
    }

    const pipelineStages = new Set(org.pipeline.map((p) => p.stage))
    const requiresGraph = resolveRequires(org)
    for (const { stage, requires } of org.pipeline) {
      if (requires === undefined) continue
      for (const dep of requires) {
        if (!pipelineStages.has(dep)) {
          errors.push(`pipeline stage "${stage}" requires unknown stage "${dep}"`)
        }
      }
    }
    const cycle = findCycle(requiresGraph)
    if (cycle) {
      errors.push(`pipeline has a dependency cycle: ${cycle.join(" -> ")}`)
    }
    for (const { stage, when } of org.pipeline) {
      if (when && "stage" in when) {
        if (!pipelineStages.has(when.stage)) {
          errors.push(`stage "${stage}" when-condition references unknown stage "${when.stage}"`)
        } else if (!isAncestor(requiresGraph, stage, when.stage)) {
          errors.push(
            `stage "${stage}" when-condition references "${when.stage}", which is not one of its (transitive) requires — its decision may be undefined when "${stage}" is evaluated`,
          )
        }
      }
    }

    return errors
  }

  /**
   * True if `candidate` is `stage`'s own transitive requires-ancestor (reachable by walking
   * `requires` backward from `stage`). Used to ensure a `when: {stage}` condition only ever reads
   * a decision that is guaranteed to be settled before `stage` is evaluated — a sibling (or any
   * stage not on `stage`'s dependency path) may still be `undefined` when `stage` is checked.
   * Cycles are tolerated (findCycle reports them separately) via a visited set.
   */
  function isAncestor(graph: Record<string, string[]>, stage: string, candidate: string): boolean {
    const visited = new Set<string>()
    const stack = [...(graph[stage] ?? [])]
    while (stack.length) {
      const node = stack.pop()!
      if (node === candidate) return true
      if (visited.has(node)) continue
      visited.add(node)
      stack.push(...(graph[node] ?? []))
    }
    return false
  }

  /** DFS cycle detection over a resolved requires graph. Returns the cycle path (a -> b -> ... -> a) or undefined. */
  function findCycle(graph: Record<string, string[]>): string[] | undefined {
    const WHITE = 0,
      GRAY = 1,
      BLACK = 2
    const color = new Map<string, number>(Object.keys(graph).map((k) => [k, WHITE]))
    const path: string[] = []

    function visit(node: string): string[] | undefined {
      color.set(node, GRAY)
      path.push(node)
      for (const dep of graph[node] ?? []) {
        if (!(dep in graph)) continue // dangling ref already reported separately
        const depColor = color.get(dep)
        if (depColor === GRAY) {
          const cycleStart = path.indexOf(dep)
          return [...path.slice(cycleStart), dep]
        }
        if (depColor === WHITE) {
          const found = visit(dep)
          if (found) return found
        }
      }
      path.pop()
      color.set(node, BLACK)
      return undefined
    }

    for (const node of Object.keys(graph)) {
      if (color.get(node) === WHITE) {
        const found = visit(node)
        if (found) return found
      }
    }
    return undefined
  }

  export function organizationPath(projectDir: string): string {
    return path.join(projectDir, ".kilo", "organization.jsonc")
  }

  export async function loadOrganization(projectDir: string): Promise<Organization> {
    const file = organizationPath(projectDir)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new Error(
            `No organization found: expected ${file}. Copy org-template/ into your project's .kilo/ directory first.`,
          )
        }
        throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    const parseErrors: ParseError[] = []
    const raw = parseJsonc(text, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length) {
      const lines = text.split("\n")
      const detail = parseErrors
        .map((e) => {
          const before = text.substring(0, e.offset).split("\n")
          const line = before.length
          const col = before[before.length - 1].length + 1
          const src = lines[line - 1]
          const msg = `${printParseErrorCode(e.error)} at line ${line}, column ${col}`
          return src ? `${msg}\n   Line ${line}: ${src}` : msg
        })
        .join("\n")
      throw new Error(`Invalid organization.jsonc at ${file}: JSONC syntax error\n${detail}`)
    }
    let org: Organization
    try {
      org = parse(raw)
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new Error(`Invalid organization.jsonc at ${file}:\n${z.prettifyError(err)}`, { cause: err })
      }
      throw err
    }
    const errors = validate(org)
    if (errors.length) throw new Error(`Invalid organization.jsonc:\n- ${errors.join("\n- ")}`)
    return org
  }

  /** Cross-check the org chart against loaded agent definitions. */
  export function crossCheck(
    org: Organization,
    agents: Record<string, { mode?: string; subordinates?: readonly string[] }>,
  ): string[] {
    const errors: string[] = []
    const ceo = agents[org.ceo]
    if (!ceo) errors.push(`ceo agent "${org.ceo}" is not defined`)
    else if (ceo.mode !== "primary") errors.push(`ceo agent "${org.ceo}" must have mode: primary`)

    const chiefs = Object.values(org.departments).map((d) => d.chief)
    for (const chief of chiefs) {
      if (!Object.hasOwn(agents, chief)) errors.push(`chief agent "${chief}" is not defined`)
      if (ceo && !(ceo.subordinates ?? []).includes(chief)) {
        errors.push(`ceo "${org.ceo}" is missing subordinate "${chief}"`)
      }
    }
    for (const [name, dept] of Object.entries(org.departments)) {
      const chief = agents[dept.chief]
      const required = [...dept.workers, ...org.shared]
      for (const agentName of required) {
        if (!Object.hasOwn(agents, agentName))
          errors.push(`agent "${agentName}" (department "${name}") is not defined`)
        if (chief && !(chief.subordinates ?? []).includes(agentName)) {
          errors.push(`chief "${dept.chief}" is missing subordinate "${agentName}"`)
        }
      }
    }
    return errors
  }
}
