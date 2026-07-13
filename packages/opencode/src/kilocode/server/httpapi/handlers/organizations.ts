// kilocode_change - Northstar project-local organization management
import path from "path"
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import { parse as parseJsonc, type ParseError, printParseErrorCode } from "jsonc-parser"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import * as ConfigAgent from "@/config/agent"
import { Filesystem } from "@/util/filesystem"
import * as InstanceState from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { OrgKnowledge } from "@/kilocode/organization/knowledge"
import { OrgSchema } from "@/kilocode/organization/schema"
import { OrgWorkspace } from "@/kilocode/organization/workspace"
import type {
  OrganizationKnowledgeImportInput,
  OrganizationKnowledgeSearchInput,
  OrganizationSaveInput,
  OrganizationStageInput,
  OrganizationUpdateInput,
} from "../groups/organizations"

export namespace OrganizationsHandler {
  const AGENT_ID = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/

  export type AgentFile = { id: string; content: string }
  export type SaveDraftInput = {
    organizationID: string
    draft: unknown
    organization: string
    agents: AgentFile[]
  }

  export type View = OrgWorkspace.Entry & {
    valid: boolean
    issues: string[]
    draft: boolean
  }

  async function exists(file: string) {
    return stat(file)
      .then(() => true)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      })
  }

  function setupPath(ctx: OrgWorkspace.Context) {
    return path.join(ctx.paths.root, ".northstar-setup.json")
  }

  function parseOrganization(text: string) {
    const errors: ParseError[] = []
    const raw = parseJsonc(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      throw new Error(errors.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`).join("\n"))
    }
    const organization = OrgSchema.parse(raw)
    const issues = OrgSchema.validate(organization)
    if (issues.length > 0) throw new Error(`Invalid organization:\n- ${issues.join("\n- ")}`)
    return organization
  }

  function validateAgentFiles(agents: AgentFile[]) {
    const seen = new Set<string>()
    for (const agent of agents) {
      if (!AGENT_ID.test(agent.id) || /^\d+$/.test(agent.id)) throw new Error(`Invalid agent id '${agent.id}'`)
      if (seen.has(agent.id)) throw new Error(`Duplicate agent id '${agent.id}'`)
      if (!agent.content.trim()) throw new Error(`Agent '${agent.id}' has no content`)
      seen.add(agent.id)
    }
  }

  async function validate(ctx: OrgWorkspace.Context) {
    try {
      const organization = await OrgWorkspace.run(ctx, () => OrgSchema.loadOrganization(ctx.projectDir))
      const agents = await ConfigAgent.load(ctx.paths.root)
      const view = Object.fromEntries(
        Object.entries(agents).map(([name, agent]) => [
          name,
          { mode: agent.mode, subordinates: (agent as { subordinates?: readonly string[] }).subordinates },
        ]),
      )
      const issues = OrgSchema.crossCheck(organization, view)
      return { valid: issues.length === 0, issues }
    } catch (error) {
      return { valid: false, issues: [error instanceof Error ? error.message : String(error)] }
    }
  }

  async function resolveAny(projectDir: string, organizationID: string) {
    return OrgWorkspace.draft(projectDir, organizationID).catch(() => OrgWorkspace.resolve(projectDir, organizationID))
  }

  async function view(ctx: OrgWorkspace.Context, draft: boolean): Promise<View> {
    const result = await validate(ctx)
    return { ...ctx.entry, ...result, draft }
  }

  export async function list(projectDir: string) {
    const registry = await OrgWorkspace.list(projectDir)
    const organizations = await Promise.all(
      registry.organizations.map(async (entry) => view(await OrgWorkspace.resolve(projectDir, entry.id), false)),
    )
    const drafts = await Promise.all((await OrgWorkspace.drafts(projectDir)).map((ctx) => view(ctx, true)))
    return { version: registry.version, active: registry.active, organizations, drafts }
  }

  export async function stage(projectDir: string, input: { name: string }) {
    const ctx = await OrgWorkspace.stage(projectDir, input.name)
    return { organization: ctx.entry, paths: ctx.paths }
  }

  export async function get(projectDir: string, organizationID: string) {
    const ctx = await resolveAny(projectDir, organizationID)
    const validation = await validate(ctx)
    const draftFile = Bun.file(setupPath(ctx))
    const organizationFile = Bun.file(ctx.paths.organization)
    const entries = await readdir(ctx.paths.agents, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    const agents = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map(async (entry) => ({ id: entry.name.slice(0, -3), content: await Bun.file(path.join(ctx.paths.agents, entry.name)).text() })),
    )
    return {
      organization: ctx.entry,
      valid: validation.valid,
      issues: validation.issues,
      draft: (await draftFile.exists()) ? await draftFile.json() : undefined,
      definition: (await organizationFile.exists()) ? await organizationFile.text() : undefined,
      agents,
    }
  }

  async function saveDefinition(ctx: OrgWorkspace.Context, input: SaveDraftInput) {
    const projectDir = ctx.projectDir
    const organization = parseOrganization(input.organization)
    validateAgentFiles(input.agents)
    const transaction = crypto.randomUUID()
    const prepared = path.join(ctx.paths.root, `.definition-${transaction}`)
    const preparedOrganization = path.join(prepared, "organization.jsonc")
    const preparedAgents = path.join(prepared, "agents")
    const preparedSetup = path.join(prepared, ".northstar-setup.json")
    await mkdir(preparedAgents, { recursive: true })
    await Filesystem.write(preparedOrganization, OrgSchema.serialize(organization))
    await Filesystem.write(preparedSetup, JSON.stringify(input.draft, null, 2) + "\n")
    await Promise.all(
      input.agents.map((agent) => Filesystem.write(path.join(preparedAgents, `${agent.id}.md`), agent.content)),
    )

    const loaded = await ConfigAgent.load(prepared)
    const agentView = Object.fromEntries(
      Object.entries(loaded).map(([name, agent]) => [
        name,
        { mode: agent.mode, subordinates: (agent as { subordinates?: readonly string[] }).subordinates },
      ]),
    )
    const issues = OrgSchema.crossCheck(organization, agentView)
    if (issues.length > 0) {
      await rm(prepared, { recursive: true, force: true })
      throw new Error(`Invalid organization agents:\n- ${issues.join("\n- ")}`)
    }

    const swaps = [
      { source: preparedOrganization, target: ctx.paths.organization, backup: `${ctx.paths.organization}.bak-${transaction}` },
      { source: preparedAgents, target: ctx.paths.agents, backup: `${ctx.paths.agents}.bak-${transaction}` },
      { source: preparedSetup, target: setupPath(ctx), backup: `${setupPath(ctx)}.bak-${transaction}` },
    ]
    const moved: typeof swaps = []
    const installed: typeof swaps = []
    try {
      for (const swap of swaps) {
        if (!(await exists(swap.target))) continue
        await rename(swap.target, swap.backup)
        moved.push(swap)
      }
      for (const swap of swaps) {
        await rename(swap.source, swap.target)
        installed.push(swap)
      }
    } catch (error) {
      await Promise.all(installed.map((swap) => rm(swap.target, { recursive: true, force: true })))
      for (const swap of moved.reverse()) await rename(swap.backup, swap.target)
      await rm(prepared, { recursive: true, force: true })
      throw error
    }
    await Promise.all(moved.map((swap) => rm(swap.backup, { recursive: true, force: true }).catch(() => undefined)))
    await rm(prepared, { recursive: true, force: true })
    return get(projectDir, input.organizationID)
  }

  export async function saveDraft(projectDir: string, input: SaveDraftInput) {
    return saveDefinition(await OrgWorkspace.draft(projectDir, input.organizationID), input)
  }

  export async function update(projectDir: string, input: SaveDraftInput & { name: string }) {
    const ctx = await OrgWorkspace.resolve(projectDir, input.organizationID)
    await saveDefinition(ctx, input)
    await OrgWorkspace.renameOrganization(projectDir, input.organizationID, input.name)
    return get(projectDir, input.organizationID)
  }

  export async function discardDraft(projectDir: string, organizationID: string) {
    await OrgWorkspace.discard(projectDir, organizationID)
    return list(projectDir)
  }

  export async function publish(projectDir: string, organizationID: string) {
    const ctx = await OrgWorkspace.draft(projectDir, organizationID)
    const validation = await validate(ctx)
    if (!validation.valid) throw new Error(`Invalid organization:\n- ${validation.issues.join("\n- ")}`)
    await OrgWorkspace.publish(projectDir, organizationID)
    return list(projectDir)
  }

  export async function select(projectDir: string, organizationID: string) {
    await OrgWorkspace.select(projectDir, organizationID)
    return list(projectDir)
  }

  export async function importKnowledge(
    projectDir: string,
    organizationID: string,
    input: { sources: string[]; scope: OrgKnowledge.Scope },
  ) {
    const ctx = await resolveAny(projectDir, organizationID)
    return OrgKnowledge.importFiles(ctx, input)
  }

  export async function searchKnowledge(
    projectDir: string,
    organizationID: string,
    input: { query: string; departmentID?: string; limit?: number },
  ) {
    const ctx = await resolveAny(projectDir, organizationID)
    return OrgKnowledge.search(ctx, input)
  }
}

export const organizationsHandlers = HttpApiBuilder.group(InstanceHttpApi, "organizations", (handlers) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const command = <A>(fn: () => Promise<A>) =>
      Effect.tryPromise({ try: fn, catch: () => new HttpApiError.BadRequest({}) })

    const list = Effect.fn("OrganizationsHttpApi.list")(function* () {
      const instance = yield* InstanceState.context
      return yield* command(() => OrganizationsHandler.list(instance.directory))
    })

    const get = Effect.fn("OrganizationsHttpApi.get")(function* (ctx: { params: { organizationID: string } }) {
      const instance = yield* InstanceState.context
      return yield* command(() => OrganizationsHandler.get(instance.directory, ctx.params.organizationID))
    })

    const stage = Effect.fn("OrganizationsHttpApi.stage")(function* (ctx: {
      payload: typeof OrganizationStageInput.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* command(() => OrganizationsHandler.stage(instance.directory, ctx.payload))
    })

    const update = Effect.fn("OrganizationsHttpApi.update")(function* (ctx: {
      params: { organizationID: string }
      payload: typeof OrganizationUpdateInput.Type
    }) {
      const instance = yield* InstanceState.context
      const result = yield* command(() =>
        OrganizationsHandler.update(instance.directory, {
          organizationID: ctx.params.organizationID,
          name: ctx.payload.name,
          draft: ctx.payload.draft,
          organization: ctx.payload.organization,
          agents: [...ctx.payload.agents],
        }),
      )
      yield* store.dispose(instance)
      return result
    })

    const saveDraft = Effect.fn("OrganizationsHttpApi.saveDraft")(function* (ctx: {
      params: { organizationID: string }
      payload: typeof OrganizationSaveInput.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* command(() =>
        OrganizationsHandler.saveDraft(instance.directory, {
          organizationID: ctx.params.organizationID,
          draft: ctx.payload.draft,
          organization: ctx.payload.organization,
          agents: [...ctx.payload.agents],
        }),
      )
    })

    const discardDraft = Effect.fn("OrganizationsHttpApi.discardDraft")(function* (ctx: {
      params: { organizationID: string }
    }) {
      const instance = yield* InstanceState.context
      return yield* command(() => OrganizationsHandler.discardDraft(instance.directory, ctx.params.organizationID))
    })

    const select = Effect.fn("OrganizationsHttpApi.select")(function* (ctx: {
      params: { organizationID: string }
    }) {
      const instance = yield* InstanceState.context
      const result = yield* command(() => OrganizationsHandler.select(instance.directory, ctx.params.organizationID))
      yield* store.dispose(instance)
      return result
    })

    const publish = Effect.fn("OrganizationsHttpApi.publish")(function* (ctx: {
      params: { organizationID: string }
    }) {
      const instance = yield* InstanceState.context
      const result = yield* command(() => OrganizationsHandler.publish(instance.directory, ctx.params.organizationID))
      yield* store.dispose(instance)
      return result
    })

    const importKnowledge = Effect.fn("OrganizationsHttpApi.importKnowledge")(function* (ctx: {
      params: { organizationID: string }
      payload: typeof OrganizationKnowledgeImportInput.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* command(() =>
        OrganizationsHandler.importKnowledge(instance.directory, ctx.params.organizationID, {
          sources: [...ctx.payload.sources],
          scope: ctx.payload.scope,
        }),
      )
    })

    const searchKnowledge = Effect.fn("OrganizationsHttpApi.searchKnowledge")(function* (ctx: {
      params: { organizationID: string }
      payload: typeof OrganizationKnowledgeSearchInput.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* command(() =>
        OrganizationsHandler.searchKnowledge(instance.directory, ctx.params.organizationID, ctx.payload),
      )
    })

    return handlers
      .handle("list", list)
      .handle("get", get)
      .handle("update", update)
      .handle("stage", stage)
      .handle("saveDraft", saveDraft)
      .handle("discardDraft", discardDraft)
      .handle("select", select)
      .handle("publish", publish)
      .handle("importKnowledge", importKnowledge)
      .handle("searchKnowledge", searchKnowledge)
  }),
)
