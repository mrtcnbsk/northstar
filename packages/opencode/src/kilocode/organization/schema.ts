// kilocode_change - new file
import path from "path"
import z from "zod"
import { parse as parseJsonc } from "jsonc-parser"

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
    shared: z.array(z.string()).default([]),
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
    const seen = new Set<string>()
    for (const { stage } of org.pipeline) {
      if (seen.has(stage)) errors.push(`duplicate pipeline stage "${stage}"`)
      seen.add(stage)
      if (!org.departments[stage]) errors.push(`pipeline stage "${stage}" has no matching department`)
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
      .catch(() => {
        throw new Error(
          `No organization found: expected ${file}. Copy org-template/ into your project's .kilo/ directory first.`,
        )
      })
    const raw = parseJsonc(text)
    const org = parse(raw)
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
      if (!agents[chief]) errors.push(`chief agent "${chief}" is not defined`)
      if (ceo && !(ceo.subordinates ?? []).includes(chief)) {
        errors.push(`ceo "${org.ceo}" is missing subordinate "${chief}"`)
      }
    }
    for (const [name, dept] of Object.entries(org.departments)) {
      const chief = agents[dept.chief]
      const required = [...dept.workers, ...org.shared]
      for (const agentName of required) {
        if (!agents[agentName]) errors.push(`agent "${agentName}" (department "${name}") is not defined`)
        if (chief && !(chief.subordinates ?? []).includes(agentName)) {
          errors.push(`chief "${dept.chief}" is missing subordinate "${agentName}"`)
        }
      }
    }
    return errors
  }
}
