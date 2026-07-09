// kilocode_change - new file
import path from "path"
import z from "zod"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"

export namespace OrgSchema {
  export const Department = z.object({
    chief: z.string().min(1),
    workers: z.array(z.string().min(1)).min(1),
  })

  export const Stage = z.object({
    stage: z.string().min(1),
    gate: z.enum(["human"]).optional(),
    haltOn: z.enum(["no-go"]).optional(),
  })

  export const Organization = z.object({
    ceo: z.string().min(1),
    departments: z.record(z.string(), Department),
    shared: z.array(z.string().min(1)).default([]),
    pipeline: z.array(Stage).min(1),
  })
  export type Organization = z.output<typeof Organization>

  export function parse(input: unknown): Organization {
    return Organization.parse(input)
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
    return errors
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
