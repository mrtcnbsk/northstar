// kilocode_change - Northstar Setup draft model and deterministic organization serialization
import z from "zod"
import { OrgKnowledge } from "../organization/knowledge"
import { OrgSchema } from "../organization/schema"

export namespace SetupModel {
  const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

  export const Step = z.enum(["organization", "departments", "agents", "knowledge", "review"])
  export type Step = z.output<typeof Step>

  export const LayerID = z.enum(["executive", "leads", "specialists"])
  export type LayerID = z.output<typeof LayerID>

  const Layer = z.object({
    name: z.string().trim().min(1),
    mission: z.string().trim().min(1),
  })

  export const Department = z.object({
    id: z.string().regex(SAFE_ID),
    name: z.string().trim().min(1),
    mission: z.string().trim().min(1),
    chief: z.string().regex(SAFE_ID),
    workers: z.array(z.string().regex(SAFE_ID)),
  })
  export type Department = z.output<typeof Department>

  const Permission = z.record(z.string().trim().min(1), z.enum(["allow", "ask", "deny"]))

  export const Agent = z.object({
    id: z.string().regex(SAFE_ID),
    name: z.string().trim().min(1),
    layer: LayerID,
    departmentID: z.string().regex(SAFE_ID).optional(),
    role: z.string().trim().min(1),
    do: z.array(z.string().trim().min(1)),
    dont: z.array(z.string().trim().min(1)),
    providerID: z.string().trim().min(1),
    modelID: z.string().trim().min(1),
    permission: Permission,
    subordinates: z.array(z.string().regex(SAFE_ID)),
  })
  export type Agent = z.output<typeof Agent>

  export const Knowledge = z.object({
    sources: z.array(z.string().trim().min(1)).min(1),
    scope: OrgKnowledge.Scope,
    status: z.record(
      z.string().trim().min(1),
      z.enum(["pending", "imported", "indexed", "unchanged", "failed"]),
    ),
  })
  export type Knowledge = z.output<typeof Knowledge>

  export const PipelineStage = z.object({
    stage: z.string().regex(SAFE_ID),
    requires: z.array(z.string().regex(SAFE_ID)).optional(),
  })

  export const Draft = z.object({
    id: z.string().regex(SAFE_ID),
    name: z.string().trim().min(1),
    step: Step,
    layers: z.object({
      executive: Layer,
      leads: Layer,
      specialists: Layer,
    }),
    departments: z.array(Department),
    agents: z.array(Agent),
    knowledge: z.array(Knowledge),
    pipeline: z.array(PipelineStage),
  })
  export type Draft = z.output<typeof Draft>

  export function blank(name: string): Draft {
    const display = name.trim() || "New organization"
    return {
      id: slug(display) || "new-organization",
      name: display,
      step: "organization",
      layers: {
        executive: { name: "Executive", mission: "Set organization direction and approve plans." },
        leads: { name: "Department Leads", mission: "Coordinate departments and verify outcomes." },
        specialists: { name: "Specialists", mission: "Produce focused, evidence-backed work." },
      },
      departments: [],
      agents: [],
      knowledge: [],
      pipeline: [],
    }
  }

  export function issues(input: unknown): string[] {
    const parsed = Draft.safeParse(input)
    if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    const draft = parsed.data
    const result: string[] = []
    const departments = new Map<string, Department>()
    const agents = new Map<string, Agent>()

    for (const department of draft.departments) {
      if (departments.has(department.id)) result.push(`Department id '${department.id}' is duplicated`)
      departments.set(department.id, department)
    }
    for (const current of draft.agents) {
      if (agents.has(current.id)) result.push(`Agent id '${current.id}' is duplicated`)
      agents.set(current.id, current)
    }

    const executives = draft.agents.filter((current) => current.layer === "executive")
    if (executives.length !== 1) result.push("The organization must have exactly one Executive agent")

    for (const department of draft.departments) {
      const chief = agents.get(department.chief)
      if (!chief) result.push(`Department '${department.id}' references missing chief '${department.chief}'`)
      else if (chief.layer !== "leads" || chief.departmentID !== department.id) {
        result.push(`Chief '${chief.id}' must be a Department Lead assigned to '${department.id}'`)
      }
      if (department.workers.length === 0) result.push(`Department '${department.id}' must have at least one worker`)
      for (const id of department.workers) {
        const worker = agents.get(id)
        if (!worker) result.push(`Department '${department.id}' references missing worker '${id}'`)
        else if (worker.layer !== "specialists" || worker.departmentID !== department.id) {
          result.push(`Worker '${id}' must be a Specialist assigned to '${department.id}'`)
        }
      }
    }

    for (const current of draft.agents) {
      if (current.layer === "executive" && current.departmentID) {
        result.push(`Executive agent '${current.id}' cannot belong to a department`)
      }
      if (current.layer !== "executive" && (!current.departmentID || !departments.has(current.departmentID))) {
        result.push(`${current.layer === "leads" ? "Department Lead" : "Specialist"} '${current.id}' must belong to a department`)
      }
      for (const subordinate of current.subordinates) {
        if (!agents.has(subordinate)) result.push(`Agent '${current.id}' references missing subordinate '${subordinate}'`)
      }
    }

    const seenStages = new Set<string>()
    for (const entry of draft.pipeline) {
      if (seenStages.has(entry.stage)) result.push(`Pipeline stage '${entry.stage}' is duplicated`)
      seenStages.add(entry.stage)
      if (!departments.has(entry.stage)) result.push(`Pipeline stage '${entry.stage}' has no matching department`)
      for (const required of entry.requires ?? []) {
        if (!draft.pipeline.some((candidate) => candidate.stage === required)) {
          result.push(`Pipeline stage '${entry.stage}' requires missing stage '${required}'`)
        }
      }
    }
    for (const department of draft.departments) {
      if (!seenStages.has(department.id)) result.push(`Department '${department.id}' is missing from the pipeline`)
    }
    for (const item of draft.knowledge) {
      if (item.scope.type === "department" && !departments.has(item.scope.departmentID)) {
        result.push(`Knowledge scope references missing department '${item.scope.departmentID}'`)
      }
    }
    return result
  }

  export function organization(input: Draft): OrgSchema.Organization {
    const draft = Draft.parse(input)
    const executive = draft.agents.find((current) => current.layer === "executive")
    if (!executive) throw new Error("The organization must have an Executive agent")
    return OrgSchema.Organization.parse({
      name: draft.name,
      layers: draft.layers,
      ceo: executive.id,
      departments: Object.fromEntries(
        draft.departments.map((department) => [
          department.id,
          {
            name: department.name,
            mission: department.mission,
            chief: department.chief,
            workers: department.workers,
          },
        ]),
      ),
      shared: [],
      pipeline: draft.pipeline,
      toolpacks: [],
    })
  }

  export function agent(input: Agent): string {
    const current = Agent.parse(input)
    const frontmatter = clean({
      description: current.role,
      displayName: current.name,
      source: "organization",
      mode: current.layer === "executive" ? "primary" : "subagent",
      model: `${current.providerID}/${current.modelID}`,
      permission: Object.keys(current.permission).length ? current.permission : undefined,
      subordinates: current.subordinates.length ? current.subordinates : undefined,
    })
    const behavior = [section("Role", [current.role], false), section("Do", current.do), section("Don't", current.dont)]
      .filter(Boolean)
      .join("\n\n")
    return `---\n${Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${format(value)}`)
      .join("\n")}\n---\n${behavior}\n`
  }

  function section(title: string, values: string[], list = true) {
    if (!values.length) return ""
    const body = list ? values.map((value) => `- ${value}`).join("\n") : values.join("\n")
    return `# ${title}\n\n${body}`
  }

  function clean(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  }

  function format(input: unknown) {
    return typeof input === "string" ? JSON.stringify(input) : JSON.stringify(input)
  }

  function slug(input: string) {
    return input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  }
}
