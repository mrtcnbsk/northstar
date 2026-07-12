// kilocode_change - new file
//
// Builder "Agents" screen (EPIC 6 Task 6.2).
//
// In-route panel (mounted inside the Builder route's content box by `view.tsx`) — NOT a dialog
// wrapper. Left: a static (mouse-driven) library of every known agent plus a "New agent" action.
// Right: a field-by-field editor for the agent currently loaded. Keyboard navigation follows the
// `DialogExportOptions` convention — a single reactive `active` field decides what Tab/Return mean,
// which lets a plain, always-mounted `<textarea>` (the prompt) coexist with cycle/picker rows
// without fighting over real terminal focus.
//
// SDK plumbing note (Task 6.2 Step 3, closed): the server-side write path (`AgentBuilder` in
// `src/kilocode/agent/builder.ts` + the `agent-builder` HttpApi group/handler) round-trips
// `subordinates`/`capabilities`/`preferredTypes`. The GENERATED SDK client
// (`packages/sdk/js/src/v2/gen/sdk.gen.ts`, `AgentBuilder.preview`/`.save`) now forwards them too —
// its `buildClientParams` body-key whitelist was hand-extended to include the three fields (a
// surgical, regen-consistent edit; a future full `bun run script/generate.ts` regen from the
// now-extended endpoint schema produces the same additions). A full regen was NOT run here because
// it would also fold in unrelated, already-drifted endpoints (`/agents` metrics, `orgRuns`) that
// are missing from the committed `packages/sdk/openapi.json` — that drift is a separate,
// pre-existing follow-up. This screen now sends subordinates/capabilities/preferredTypes on both
// preview and save; the round-trip is exercised end-to-end by
// `test/kilocode/server/agent-builder.test.ts` (real HTTP handler) and
// `test/kilocode/agent/builder-org-fields.test.ts` (in-process writer).

import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import type { Agent, PermissionAction } from "@kilocode/sdk/v2"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { useBindings } from "@tui/keymap"

type Mode = "primary" | "subagent" | "all"
type PermKey = "edit" | "bash" | "webfetch" | "websearch"

// "task" is intentionally NOT a manual toggle here: `ConfigAgent`'s `normalize` (src/config/agent.ts)
// expands `subordinates` into `permission.task` on load, but an explicit `permission.task` on the
// same agent wins over that expansion (see test/kilocode/organization/subordinates.test.ts). A
// generic allow/ask/deny toggle for "task" would silently break org delegation for any agent that
// also declares subordinates, so task permission stays implicit (driven only by subordinates).
const PERMISSION_KEYS: PermKey[] = ["edit", "bash", "webfetch", "websearch"]
const PERMISSION_LABELS: Record<PermKey, string> = {
  edit: "Edit",
  bash: "Bash",
  webfetch: "Web fetch",
  websearch: "Web search",
}
const PERMISSION_CYCLE: PermissionAction[] = ["allow", "ask", "deny"]
const MODE_CYCLE: Mode[] = ["primary", "subagent", "all"]

type FieldKey = "name" | "description" | "mode" | "model" | `permission:${PermKey}` | "subordinates" | "prompt" | "save"

const FIELD_ORDER: FieldKey[] = [
  "name",
  "description",
  "mode",
  "model",
  ...PERMISSION_KEYS.map((key) => `permission:${key}` as const),
  "subordinates",
  "prompt",
  "save",
]

type Draft = {
  original?: string
  id: string
  description: string
  mode: Mode
  providerID: string
  modelID: string
  permission: Record<PermKey, PermissionAction>
  subordinates: string[]
  capabilities: string[]
  preferredTypes: string[]
  prompt: string
}

function blankDraft(): Draft {
  return {
    original: undefined,
    id: "",
    description: "",
    mode: "subagent",
    providerID: "",
    modelID: "",
    permission: { edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask" },
    subordinates: [],
    capabilities: [],
    preferredTypes: [],
    prompt: "",
  }
}

function draftFromAgent(agent: Agent): Draft {
  const permission = { edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask" } as Record<PermKey, PermissionAction>
  for (const key of PERMISSION_KEYS) {
    const rule = agent.permission.find((item) => item.permission === key && item.pattern === "*")
    if (rule) permission[key] = rule.action
  }
  return {
    original: agent.name,
    id: agent.name,
    description: agent.description ?? "",
    mode: agent.mode === "subagent" || agent.mode === "all" ? agent.mode : "primary",
    providerID: agent.model?.providerID ?? "",
    modelID: agent.model?.modelID ?? "",
    permission,
    subordinates: [...(agent.subordinates ?? [])],
    capabilities: [...(agent.capabilities ?? [])],
    preferredTypes: [...(agent.preferredTypes ?? [])],
    prompt: agent.prompt ?? "",
  }
}

export function AgentsScreen() {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [draft, setDraft] = createStore<Draft>(blankDraft())
  const [active, setActive] = createSignal<FieldKey>("name")
  const [saving, setSaving] = createSignal(false)
  let textarea: TextareaRenderable | undefined

  const agents = createMemo(() => sync.data.agent)

  function load(agent?: Agent) {
    setDraft(agent ? draftFromAgent(agent) : blankDraft())
    setActive("name")
  }

  const modelOptions = createMemo(() =>
    sync.data.provider.flatMap((provider) =>
      Object.keys(provider.models).map((modelID) => ({
        value: { providerID: provider.id, modelID },
        title: `${provider.id}/${modelID}`,
        category: provider.name,
      })),
    ),
  )

  function pickModel() {
    dialog.replace(() => (
      <DialogSelect
        title="Model"
        options={modelOptions()}
        current={draft.providerID ? { providerID: draft.providerID, modelID: draft.modelID } : undefined}
        onSelect={(option) => {
          setDraft("providerID", option.value.providerID)
          setDraft("modelID", option.value.modelID)
          dialog.clear()
        }}
      />
    ))
  }

  function pickSubordinates() {
    dialog.replace(() => (
      <DialogSelect
        title="Subordinates (enter to toggle, esc when done)"
        options={agents()
          .filter((item) => item.name !== (draft.original ?? draft.id))
          .map((item) => ({
            value: item.name,
            title: item.name,
            description: draft.subordinates.includes(item.name) ? "selected" : undefined,
            onSelect: () => {
              setDraft("subordinates", (list) =>
                list.includes(item.name) ? list.filter((name) => name !== item.name) : [...list, item.name],
              )
            },
          }))}
      />
    ))
  }

  async function editText(field: "name" | "description") {
    const title = field === "name" ? "Agent name" : "Description"
    const value = await DialogPrompt.show(dialog, title, { value: field === "name" ? draft.id : draft.description })
    if (value === null) return
    if (field === "name") setDraft("id", value.trim())
    else setDraft("description", value.trim())
  }

  function activateField(field: FieldKey) {
    if (field === "name" || field === "description") {
      void editText(field)
      return
    }
    if (field === "mode") {
      setDraft("mode", MODE_CYCLE[(MODE_CYCLE.indexOf(draft.mode) + 1) % MODE_CYCLE.length])
      return
    }
    if (field === "model") {
      pickModel()
      return
    }
    if (field.startsWith("permission:")) {
      const key = field.slice("permission:".length) as PermKey
      const next = PERMISSION_CYCLE[(PERMISSION_CYCLE.indexOf(draft.permission[key]) + 1) % PERMISSION_CYCLE.length]
      setDraft("permission", key, next)
      return
    }
    if (field === "subordinates") {
      pickSubordinates()
      return
    }
    if (field === "prompt") {
      textarea?.focus()
      return
    }
    if (field === "save") {
      void save()
    }
  }

  function gather() {
    return {
      id: draft.id.trim(),
      scope: "project" as const,
      description: draft.description.trim() || undefined,
      mode: draft.mode,
      model: draft.providerID && draft.modelID ? `${draft.providerID}/${draft.modelID}` : undefined,
      permission: Object.fromEntries(PERMISSION_KEYS.map((key) => [key, draft.permission[key]])),
      // Always forwarded (even when empty): `AgentBuilder.markdown` rewrites the whole frontmatter
      // each save and omits these keys when the array is empty (src/kilocode/agent/builder.ts), so
      // sending `[]` correctly clears a field that was previously set (e.g. removing the last
      // subordinate in the picker) rather than leaving it unresolved.
      subordinates: [...draft.subordinates],
      capabilities: [...draft.capabilities],
      preferredTypes: [...draft.preferredTypes],
      // EditBufferRenderable exposes no onInput/onChange prop, only onContentChange (fires per
      // keystroke) or reading `.plainText` on demand — matching DialogExportOptions/DialogPrompt,
      // which both read `textarea.plainText` at submit time rather than mirroring it into a store.
      prompt: (textarea?.plainText ?? "").trim(),
    }
  }

  async function save() {
    if (saving()) return
    const payload = gather()
    if (!payload.id) {
      toast.show({ variant: "warning", message: "Agent needs a name before saving.", duration: 4000 })
      return
    }
    if (!payload.prompt.trim()) {
      toast.show({ variant: "warning", message: "Agent needs a prompt before saving.", duration: 4000 })
      return
    }

    setSaving(true)
    try {
      const preview = await sdk.client.agentBuilder.preview(payload, { throwOnError: true })
      const markdown = preview.data?.markdown ?? ""
      const confirmed = await DialogConfirm.show(dialog, `Save "${payload.id}"?`, markdown, "Cancel")
      if (!confirmed) return

      await sdk.client.agentBuilder.save({ path_id: payload.id, ...payload }, { throwOnError: true })
      await sdk.client.instance.dispose()
      await sync.bootstrap()
      setDraft("original", payload.id)

      toast.show({ variant: "success", message: `Saved agent "${payload.id}".`, duration: 3000 })
    } catch (err) {
      toast.show({
        variant: "error",
        message: err instanceof Error ? err.message : "Failed to save agent.",
        duration: 5000,
      })
    } finally {
      setSaving(false)
    }
  }

  useBindings(() => ({
    bindings: [
      {
        key: "tab",
        desc: "Next field",
        group: "Agents",
        cmd: () => {
          const next = FIELD_ORDER[(FIELD_ORDER.indexOf(active()) + 1) % FIELD_ORDER.length]
          setActive(next)
        },
      },
    ],
  }))

  useBindings(() => ({
    enabled: active() !== "prompt" && !saving(),
    bindings: [
      {
        key: "return",
        desc: "Activate field",
        group: "Agents",
        cmd: () => activateField(active()),
      },
    ],
  }))

  function Row(props: { field: FieldKey; label: string; value: string }) {
    const isActive = createMemo(() => active() === props.field)
    return (
      <box
        flexDirection="row"
        gap={2}
        paddingLeft={1}
        backgroundColor={isActive() ? theme.backgroundElement : undefined}
        onMouseUp={() => {
          setActive(props.field)
          activateField(props.field)
        }}
      >
        <text fg={isActive() ? theme.primary : theme.text}>{props.label}</text>
        <text fg={isActive() ? theme.primary : theme.textMuted}>{props.value || "(none)"}</text>
      </box>
    )
  }

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexDirection="column" width={30} flexShrink={0} paddingRight={2} gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Agents
        </text>
        <box
          paddingLeft={1}
          backgroundColor={draft.original === undefined ? theme.backgroundElement : undefined}
          onMouseUp={() => load(undefined)}
        >
          <text fg={draft.original === undefined ? theme.primary : theme.text}>+ New agent</text>
        </box>
        <scrollbox scrollbarOptions={{ visible: false }} flexGrow={1}>
          <For each={agents()}>
            {(agent) => (
              <box
                paddingLeft={1}
                backgroundColor={draft.original === agent.name ? theme.backgroundElement : undefined}
                onMouseUp={() => load(agent)}
              >
                <text fg={draft.original === agent.name ? theme.primary : theme.text}>
                  {agent.name} <span style={{ fg: theme.textMuted }}>{agent.mode}</span>
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
      <box flexDirection="column" flexGrow={1} gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {draft.original ? `Editing ${draft.original}` : "New agent"}
        </text>
        <Row field="name" label="Name" value={draft.id} />
        <Row field="description" label="Description" value={draft.description} />
        <Row field="mode" label="Mode" value={draft.mode} />
        <Row field="model" label="Model" value={draft.providerID ? `${draft.providerID}/${draft.modelID}` : ""} />
        <For each={PERMISSION_KEYS}>
          {(key) => <Row field={`permission:${key}`} label={PERMISSION_LABELS[key]} value={draft.permission[key]} />}
        </For>
        <Row field="subordinates" label="Subordinates" value={draft.subordinates.join(", ")} />
        <box gap={1}>
          <box onMouseUp={() => {
            setActive("prompt")
            textarea?.focus()
          }}>
            <text fg={active() === "prompt" ? theme.primary : theme.text}>Prompt</text>
          </box>
          <textarea
            height={8}
            ref={(val: TextareaRenderable) => (textarea = val)}
            initialValue={draft.prompt}
            placeholder="Agent system prompt"
            placeholderColor={theme.textMuted}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.text}
          />
        </box>
        <box
          paddingLeft={1}
          paddingTop={1}
          backgroundColor={active() === "save" ? theme.backgroundElement : undefined}
          onMouseUp={() => {
            setActive("save")
            activateField("save")
          }}
        >
          <Show when={!saving()} fallback={<text fg={theme.textMuted}>Saving...</text>}>
            <text fg={active() === "save" ? theme.primary : theme.text}>Save agent</text>
          </Show>
        </box>
      </box>
    </box>
  )
}
