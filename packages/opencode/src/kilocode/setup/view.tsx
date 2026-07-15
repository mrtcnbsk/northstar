// kilocode_change - Northstar guided, resumable organization Setup
import { createMemo, createSignal, Match, onMount, Show, Switch } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"
import { OrgSchema } from "../organization/schema"
import type { OrgKnowledge } from "../organization/knowledge"
import { SetupModel } from "./model"
import { OrganizationStep } from "./organization-step"
import { DepartmentsStep } from "./departments-step"
import { AgentsStep } from "./agents-step"
import { KnowledgeStep } from "./knowledge-step"
import { ReviewStep } from "./review-step"

export type SetupDefinition = { organization: string; agents: Array<{ id: string; content: string }> }
export type SetupMode = "create" | "edit" | "repair"

export type SetupWorkflowAPI = {
  stage(name: string): Promise<{ id: string }>
  saveDraft(id: string, draft: SetupModel.Draft, definition?: SetupDefinition): Promise<void>
  importKnowledge(
    id: string,
    sources: string[],
    scope: OrgKnowledge.Scope,
  ): Promise<Array<{ source: string; status: "indexed" | "unchanged" }>>
  publish(id: string): Promise<void>
  update(id: string, draft: SetupModel.Draft, definition: SetupDefinition): Promise<void>
  refresh(): Promise<void>
}

export function createSetupWorkflow(input: {
  api: SetupWorkflowAPI
  draft: SetupModel.Draft
  organizationID?: string
  mode?: SetupMode
  onFinished?: (organizationID: string) => void
}) {
  let current = SetupModel.Draft.parse(structuredClone(input.draft))
  let organizationID = input.organizationID
  let mode = input.mode ?? "create"
  let dirty = false

  function replace(next: SetupModel.Draft) {
    current = SetupModel.Draft.parse(structuredClone(next))
    dirty = true
  }

  async function ensureStaged() {
    if (organizationID) return organizationID
    const staged = await input.api.stage(current.name)
    organizationID = staged.id
    if (current.id !== staged.id) current = { ...current, id: staged.id }
    return organizationID
  }

  async function persist(step: SetupModel.Step) {
    const id = await ensureStaged()
    current = { ...current, step }
    await input.api.saveDraft(id, current)
    dirty = false
  }

  function definition(): SetupDefinition {
    return {
      organization: OrgSchema.serialize(SetupModel.organization(current)),
      agents: current.agents.map((agent) => ({ id: agent.id, content: SetupModel.agent(agent) })),
    }
  }

  function issues() {
    const result = SetupModel.issues(current)
    for (const selection of current.knowledge) {
      for (const source of selection.sources) {
        const status = selection.status[source]
        if (status === "pending" || status === "failed" || status === undefined) {
          result.push(`Knowledge file '${source}' must be imported successfully`)
        }
      }
    }
    return [...new Set(result)]
  }

  return {
    draft: () => current,
    organizationID: () => organizationID,
    mode: () => mode,
    dirty: () => dirty,
    issues,
    replace,
    setMode(next: SetupMode) {
      mode = next
    },
    async go(step: SetupModel.Step) {
      await persist(step)
    },
    async importFiles(sources: string[], scope: OrgKnowledge.Scope) {
      const id = await ensureStaged()
      const status = Object.fromEntries(sources.map((source) => [source, "pending" as const]))
      current = {
        ...current,
        knowledge: [...current.knowledge, { sources: [...sources], scope, status }],
      }
      await input.api.saveDraft(id, current)
      try {
        const result = await input.api.importKnowledge(id, sources, scope)
        const returned = new Map(result.map((file) => [file.source, file.status]))
        const indexed = Object.fromEntries(
          sources.map((source, index) => [source, returned.get(source) ?? result[index]?.status ?? "failed"]),
        )
        current = {
          ...current,
          knowledge: current.knowledge.map((selection, index, all) =>
            index === all.length - 1 ? { ...selection, status: { ...selection.status, ...indexed } } : selection,
          ),
        }
      } catch (error) {
        current = {
          ...current,
          knowledge: current.knowledge.map((selection, index, all) =>
            index === all.length - 1
              ? {
                  ...selection,
                  status: Object.fromEntries(selection.sources.map((source) => [source, "failed" as const])),
                }
              : selection,
          ),
        }
        await input.api.saveDraft(id, current)
        throw error
      }
      await input.api.saveDraft(id, current)
    },
    async finish() {
      const invalid = issues()
      if (invalid.length) throw new Error(invalid.join("\n"))
      const id = await ensureStaged()
      const output = definition()
      if (mode === "edit" || mode === "repair") await input.api.update(id, current, output)
      else {
        await input.api.saveDraft(id, current, output)
        await input.api.publish(id)
      }
      await input.api.refresh()
      dirty = false
      input.onFinished?.(id)
    },
  }
}

const STEPS: SetupModel.Step[] = ["organization", "departments", "agents", "knowledge", "review"]

export function SetupView(props: {
  organizationID?: string
  mode?: SetupMode
  draft?: SetupModel.Draft
  onPublished?: (organizationID: string) => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [draft, setDraft] = createSignal(SetupModel.Draft.parse(props.draft ?? SetupModel.blank("New organization")))
  const [busy, setBusy] = createSignal(false)
  const [loading, setLoading] = createSignal(Boolean(props.organizationID && !props.draft))
  const [error, setError] = createSignal<string>()

  const routed = () => ({ workspace: project.workspace.current() })
  const api: SetupWorkflowAPI = {
    async stage(name) {
      const response = await sdk.client.organizations.stage({ ...routed(), name }, { throwOnError: true })
      const id = response.data?.organization.id
      if (!id) throw new Error("Northstar did not return a staged organization id")
      return { id }
    },
    async saveDraft(id, next, definition) {
      await sdk.client.organizations.saveDraft(
        {
          organizationID: id,
          ...routed(),
          draft: next,
          organization: definition?.organization,
          agents: definition?.agents,
        },
        { throwOnError: true },
      )
    },
    async importKnowledge(id, sources, scope) {
      const response = await sdk.client.organizations.importKnowledge(
        { organizationID: id, ...routed(), sources, scope },
        { throwOnError: true },
      )
      return (response.data?.files ?? []).map((file) => ({ source: file.source, status: file.status }))
    },
    async publish(id) {
      await sdk.client.organizations.publish({ organizationID: id, ...routed() }, { throwOnError: true })
    },
    async update(id, next, definition) {
      await sdk.client.organizations.update(
        { organizationID: id, ...routed(), name: next.name, draft: next, ...definition },
        { throwOnError: true },
      )
    },
    async refresh() {
      await sdk.client.instance.dispose(routed())
      await sync.bootstrap()
    },
  }
  const workflow = createSetupWorkflow({
    api,
    draft: draft(),
    organizationID: props.organizationID,
    mode: props.mode,
    onFinished: props.onPublished,
  })

  function syncDraft(next?: SetupModel.Draft) {
    if (next) workflow.replace(next)
    setDraft(structuredClone(workflow.draft()))
    props.onDirtyChange?.(workflow.dirty())
  }

  function message(reason: unknown) {
    return reason instanceof Error ? reason.message : String(reason)
  }

  async function guarded(action: () => Promise<void>, prefix = "Could not save organization") {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await action()
      syncDraft()
    } catch (reason) {
      const value = `${prefix}: ${message(reason)}`
      setError(value)
      toast.show({ variant: "error", message: value, duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  onMount(async () => {
    if (!props.organizationID || props.draft) return
    try {
      const response = await sdk.client.organizations.get(
        { organizationID: props.organizationID, ...routed() },
        { throwOnError: true },
      )
      const data = response.data
      if (!data) throw new Error("Organization Setup data is unavailable")
      if (!data.draft)
        throw new Error("This organization predates guided Setup and must be repaired from its definition")
      const next = SetupModel.Draft.parse(data.draft)
      workflow.replace(next)
      workflow.setMode(data.organization.root.includes(".staging/") ? "create" : (props.mode ?? "edit"))
      syncDraft()
    } catch (reason) {
      setError(`Could not load organization: ${message(reason)}`)
    } finally {
      setLoading(false)
    }
  })

  const stepIndex = createMemo(() => STEPS.indexOf(draft().step))
  const issues = createMemo(() => workflow.issues())

  async function go(delta: -1 | 1) {
    const next = STEPS[stepIndex() + delta]
    if (!next) return
    await guarded(() => workflow.go(next))
  }

  function replace(mutator: (next: SetupModel.Draft) => void) {
    const next = structuredClone(draft())
    mutator(next)
    syncDraft(next)
  }

  async function prompt(title: string, value = "") {
    return DialogPrompt.show(dialog, title, { value })
  }

  function choose<T>(title: string, options: DialogSelectOption<T>[]) {
    return new Promise<T | undefined>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title={title}
            options={options}
            onSelect={(option) => {
              dialog.clear()
              resolve(option.value)
            }}
          />
        ),
        () => resolve(undefined),
      )
    })
  }

  async function editName() {
    const value = await prompt("Organization name", draft().name)
    if (!value?.trim()) return
    replace((next) => {
      next.name = value.trim()
      if (!workflow.organizationID()) next.id = SetupModel.blank(value).id
    })
  }

  async function editLayer(id: SetupModel.LayerID) {
    const current = draft().layers[id]
    const name = await prompt("Layer name", current.name)
    if (!name?.trim()) return
    const mission = await prompt("Layer mission", current.mission)
    if (!mission?.trim()) return
    replace((next) => {
      next.layers[id] = { name: name.trim(), mission: mission.trim() }
    })
  }

  async function addDepartment() {
    const name = await prompt("Department name")
    if (!name?.trim()) return
    const mission = await prompt("Department mission")
    if (!mission?.trim()) return
    const id = SetupModel.blank(name).id
    if (draft().departments.some((department) => department.id === id)) {
      setError(`Department '${id}' already exists`)
      return
    }
    replace((next) => {
      next.departments.push({ id, name: name.trim(), mission: mission.trim(), chief: "", workers: [] })
      next.pipeline.push({ stage: id })
    })
  }

  async function editDepartment(id: string) {
    const current = draft().departments.find((department) => department.id === id)
    if (!current) return
    const name = await prompt("Department name", current.name)
    if (!name?.trim()) return
    const mission = await prompt("Department mission", current.mission)
    if (!mission?.trim()) return
    replace((next) => {
      const department = next.departments.find((item) => item.id === id)
      if (department) Object.assign(department, { name: name.trim(), mission: mission.trim() })
    })
  }

  function removeDepartment(id: string) {
    replace((next) => {
      next.departments = next.departments.filter((department) => department.id !== id)
      next.agents = next.agents.filter((agent) => agent.departmentID !== id)
      next.knowledge = next.knowledge.filter(
        (item) => item.scope.type !== "department" || item.scope.departmentID !== id,
      )
      next.pipeline = next.pipeline
        .filter((stage) => stage.stage !== id)
        .map((stage) => ({ ...stage, requires: stage.requires?.filter((item) => item !== id) }))
      deriveHierarchy(next)
    })
  }

  const modelOptions = () =>
    sync.data.provider.flatMap((provider) =>
      Object.keys(provider.models).map((modelID) => ({
        value: { providerID: provider.id, modelID },
        title: `${provider.id}/${modelID}`,
        category: provider.name,
      })),
    )

  async function editAgent(id?: string) {
    const current = id ? draft().agents.find((agent) => agent.id === id) : undefined
    const layer = await choose<SetupModel.LayerID>("Agent layer", [
      ...(!draft().agents.some((agent) => agent.layer === "executive" && agent.id !== id)
        ? [{ value: "executive" as const, title: draft().layers.executive.name }]
        : []),
      { value: "leads", title: draft().layers.leads.name },
      { value: "specialists", title: draft().layers.specialists.name },
    ])
    if (!layer) return
    let departmentID: string | undefined
    if (layer !== "executive") {
      departmentID = await choose(
        "Department",
        draft().departments.map((department) => ({ value: department.id, title: department.name })),
      )
      if (!departmentID) return
    }
    const name = await prompt("Agent display name", current?.name ?? "")
    if (!name?.trim()) return
    const agentID = current?.id ?? SetupModel.blank(name).id
    if (!current && draft().agents.some((agent) => agent.id === agentID)) {
      setError(`Agent '${agentID}' already exists`)
      return
    }
    const role = await prompt("Agent role", current?.role ?? "")
    if (!role?.trim()) return
    const doRules = await prompt("Do rules (separate with ;)", current?.do.join("; ") ?? "")
    if (doRules === null) return
    const dontRules = await prompt("Don't rules (separate with ;)", current?.dont.join("; ") ?? "")
    if (dontRules === null) return
    const model = await choose("Agent model", modelOptions())
    if (!model) return
    const nextAgent: SetupModel.Agent = {
      id: agentID,
      name: name.trim(),
      layer,
      departmentID,
      role: role.trim(),
      do: splitRules(doRules),
      dont: splitRules(dontRules),
      providerID: model.providerID,
      modelID: model.modelID,
      permission: current?.permission ?? { edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask" },
      subordinates: [],
    }
    replace((next) => {
      const index = next.agents.findIndex((agent) => agent.id === agentID)
      if (index === -1) next.agents.push(nextAgent)
      else next.agents[index] = nextAgent
      deriveHierarchy(next)
    })
  }

  function removeAgent(id: string) {
    replace((next) => {
      next.agents = next.agents.filter((agent) => agent.id !== id)
      deriveHierarchy(next)
    })
  }

  async function importKnowledge() {
    const scope = await choose<OrgKnowledge.Scope>("Knowledge destination", [
      { value: { type: "shared" }, title: "Shared knowledge", description: "Readable by every department" },
      ...draft().departments.map((department) => ({
        value: { type: "department" as const, departmentID: department.id },
        title: department.name,
        description: "Private to this department",
      })),
    ])
    if (!scope) return
    const response = await sdk.client.find.files({ query: "", ...routed() })
    const source = await choose(
      "Select a workspace file",
      (response.data ?? []).map((file) => ({ value: file, title: file })),
    )
    if (!source) return
    await guarded(() => workflow.importFiles([source], scope), "Could not import knowledge")
  }

  function removeKnowledge(index: number) {
    replace((next) => next.knowledge.splice(index, 1))
  }

  async function finish() {
    await guarded(() => workflow.finish(), "Could not create organization")
  }

  function primaryAction() {
    if (draft().step === "organization") return void editName()
    if (draft().step === "departments") return void addDepartment()
    if (draft().step === "agents") return void editAgent()
    if (draft().step === "knowledge") return void importKnowledge()
    return void finish()
  }

  useBindings(() => ({
    // kilocode_change - Finding: these single-key Setup shortcuts (a / return / left / right) must be
    // suppressed while a prompt dialog is open, or they hijack text entry — typing an org name or
    // mission would trigger "add/edit", "next step", or step navigation instead of inserting the
    // character, dismissing or switching the screen mid-edit.
    enabled: !busy() && !loading() && dialog.stack.length === 0,
    bindings: [
      { key: "left", desc: "Previous Setup step", group: "Setup", cmd: () => void go(-1) },
      { key: "right", desc: "Next Setup step", group: "Setup", cmd: () => void go(1) },
      { key: "a", desc: "Add or edit", group: "Setup", cmd: primaryAction },
      {
        key: "return",
        desc: draft().step === "review" ? "Create organization" : "Next Setup step",
        group: "Setup",
        cmd: () => (draft().step === "review" ? void finish() : void go(1)),
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          NORTHSTAR SETUP
        </text>
        <text fg={theme.textMuted}>
          Step {stepIndex() + 1} of {STEPS.length}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        {STEPS.map((step, index) => (
          <text fg={draft().step === step ? theme.primary : index < stepIndex() ? theme.success : theme.textMuted}>
            {index + 1} {title(step)}
          </text>
        ))}
      </box>
      <Show when={error()}>{(value) => <text fg={theme.error}>{value()}</text>}</Show>
      <Show when={!loading()} fallback={<text fg={theme.textMuted}>Loading organization Setup...</text>}>
        <scrollbox flexGrow={1} scrollbarOptions={{ visible: false }}>
          <Switch>
            <Match when={draft().step === "organization"}>
              <OrganizationStep
                draft={draft()}
                onEditName={() => void editName()}
                onEditLayer={(layer) => void editLayer(layer)}
              />
            </Match>
            <Match when={draft().step === "departments"}>
              <DepartmentsStep
                draft={draft()}
                onAdd={() => void addDepartment()}
                onEdit={(id) => void editDepartment(id)}
                onRemove={removeDepartment}
              />
            </Match>
            <Match when={draft().step === "agents"}>
              <AgentsStep
                draft={draft()}
                onAdd={() => void editAgent()}
                onEdit={(id) => void editAgent(id)}
                onRemove={removeAgent}
              />
            </Match>
            <Match when={draft().step === "knowledge"}>
              <KnowledgeStep draft={draft()} onImport={() => void importKnowledge()} onRemove={removeKnowledge} />
            </Match>
            <Match when={draft().step === "review"}>
              <ReviewStep
                draft={draft()}
                issues={issues()}
                busy={busy()}
                edit={workflow.mode() !== "create"}
                onSubmit={() => void finish()}
              />
            </Match>
          </Switch>
        </scrollbox>
      </Show>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={stepIndex() > 0 ? theme.text : theme.textMuted} onMouseUp={() => stepIndex() > 0 && void go(-1)}>
          ← Previous
        </text>
        <text fg={theme.textMuted}>a add/edit · ←/→ steps</text>
        <text fg={theme.primary} onMouseUp={() => (draft().step === "review" ? void finish() : void go(1))}>
          {draft().step === "review"
            ? workflow.mode() === "create"
              ? "Create organization"
              : "Save changes"
            : "Next →"}
        </text>
      </box>
    </box>
  )
}

function splitRules(input: string) {
  return input
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
}

function deriveHierarchy(draft: SetupModel.Draft) {
  const leads = draft.agents.filter((agent) => agent.layer === "leads")
  const specialists = draft.agents.filter((agent) => agent.layer === "specialists")
  for (const department of draft.departments) {
    department.chief = leads.find((agent) => agent.departmentID === department.id)?.id ?? ""
    department.workers = specialists.filter((agent) => agent.departmentID === department.id).map((agent) => agent.id)
  }
  for (const agent of draft.agents) {
    if (agent.layer === "executive") agent.subordinates = leads.map((lead) => lead.id)
    else if (agent.layer === "leads") {
      agent.subordinates = specialists
        .filter((specialist) => specialist.departmentID === agent.departmentID)
        .map((specialist) => specialist.id)
    } else agent.subordinates = []
  }
}

function title(step: SetupModel.Step) {
  return step[0].toUpperCase() + step.slice(1)
}
