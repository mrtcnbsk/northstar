// kilocode_change - new file
//
// Builder "Organization" screen (EPIC 6 Task 6.3).
//
// In-route panel (mounted inside the Builder route's content box by `view.tsx`) — NOT a dialog
// wrapper. Left: quick-start actions + a read-only org-chart tree (ceo -> departments{chief ->
// workers}). Right: a pipeline editor (add / move ± 1 / toggle-gate) over an in-memory draft, plus
// a live validation panel.
//
// READ/WRITE PATH NOTE (Task 6.3 Step 3, investigated — see the task report for the full writeup):
// Unlike Agents (Task 6.2, `agentBuilder` HttpApi group + generated SDK client), there is NO
// org-specific HttpApi group/SDK method for organization.jsonc — `OrgSchema.loadOrganization` /
// `writeOrganization` (schema.ts) are server-side fs functions with no client-callable counterpart.
//   - READ: this screen reuses the EXISTING, generic, non-org-specific `/file/content` endpoint
//     (`sdk.client.file.read`, already used elsewhere for arbitrary project files, e.g.
//     `dialog-tag.tsx`'s `find.files`) to fetch `.kilo/organization.jsonc` as text, then parses it
//     client-side with the same `jsonc-parser` + `OrgSchema.parse` the server uses. This is NOT a
//     new endpoint — `/file/content` already reads any project-relative path.
//   - WRITE: no generic write endpoint exists (`File` HttpApi group is read-only: list/content/
//     status), and no org-specific one exists either. Per the Task 6.3 brief this screen must NOT
//     invent one. Save is therefore left un-wired: it surfaces a toast explaining the gap instead
//     of silently doing nothing or fabricating a network call. The mandatory, testable core
//     (`OrgSchema.serialize`/`writeOrganization`, Step 1-2) is already correct and
//     server-importable — a follow-up (an `org-builder` HttpApi group mirroring `agent-builder`)
//     is what would close this loop.
// `OrgSchema.validate`/`crossCheck` are pure (no I/O) and imported directly for live validation of
// the in-memory draft — that part needs no server round-trip at all.

import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { parse as parseJsonc } from "jsonc-parser"
import { TextAttributes } from "@opentui/core"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useProject } from "@tui/context/project"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { DialogSelect } from "@tui/ui/dialog-select"
import { OrgSchema } from "@/kilocode/organization/schema"

// Mirrors `OrgSchema.organizationPath`'s relative suffix — the generic `/file/content` endpoint
// takes a project-relative path, not an absolute one, so we can't call `organizationPath` itself
// (it needs a project directory this client-side module never has).
const ORG_RELATIVE_PATH = ".kilo/organization.jsonc"

// Quick-start skeletons. These do NOT read the bundled templates/ directory (`OrgTemplates.list` in
// `cli/cmd/org.ts` is fs-based and server-only, same gap as the write path above) — they're small,
// hand-written starting points shaped like `templates/blank` and `templates/ios-app-factory`'s
// build->ship spine, purely so the editor has something to mutate before a real organization.jsonc
// exists. Scaffolding from the actual bundled templates remains a CLI-only feature today
// (`northstar org init --template <name>`).
function blankSkeleton(): OrgSchema.Organization {
  return {
    ceo: "ceo",
    departments: { work: { chief: "lead", workers: ["worker"] } },
    shared: [],
    pipeline: [{ stage: "work" }],
    toolpacks: [],
  }
}

function sampleSkeleton(): OrgSchema.Organization {
  return {
    ceo: "ceo",
    departments: {
      build: { chief: "build-chief", workers: ["builder"] },
      ship: { chief: "ship-chief", workers: ["shipper"] },
    },
    shared: [],
    pipeline: [
      { stage: "build", gate: "human", haltOn: "no-go" },
      { stage: "ship", requires: ["build"] },
    ],
    toolpacks: [],
  }
}

type FileStatus =
  | { kind: "loading" }
  | { kind: "loaded" }
  | { kind: "empty" }
  | { kind: "error"; message: string }

export function OrganizationScreen() {
  const sync = useSync()
  const sdk = useSDK()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const [draft, setDraft] = createStore<OrgSchema.Organization>(blankSkeleton())
  const [status, setStatus] = createSignal<FileStatus>({ kind: "loading" })

  const [orgFile, { refetch }] = createResource(async () => {
    return sdk.client.file.read({ path: ORG_RELATIVE_PATH, workspace: project.workspace.current() })
  })

  createEffect(() => {
    const result = orgFile()
    if (!result) return
    if (result.error || !result.data) {
      setStatus({ kind: "empty" })
      return
    }
    const content = result.data.type === "text" ? result.data.content.trim() : ""
    if (!content) {
      setStatus({ kind: "empty" })
      return
    }
    try {
      const parsed = OrgSchema.parse(parseJsonc(content))
      setDraft(reconcile(parsed))
      setStatus({ kind: "loaded" })
    } catch (err) {
      setStatus({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    }
  })

  const agentsView = createMemo(() =>
    Object.fromEntries(sync.data.agent.map((agent) => [agent.name, { mode: agent.mode, subordinates: agent.subordinates }])),
  )

  const issues = createMemo(() => [...OrgSchema.validate(draft), ...OrgSchema.crossCheck(draft, agentsView())])

  function seed(org: OrgSchema.Organization) {
    setDraft(reconcile(org))
    setStatus({ kind: "empty" })
  }

  function reload() {
    setStatus({ kind: "loading" })
    void refetch()
  }

  function moveStage(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= draft.pipeline.length) return
    const next = [...draft.pipeline]
    ;[next[index], next[target]] = [next[target], next[index]]
    setDraft("pipeline", next)
  }

  function toggleGate(index: number) {
    setDraft("pipeline", index, "gate", (gate) => (gate === "human" ? undefined : "human"))
  }

  function addStage() {
    const used = new Set(draft.pipeline.map((entry) => entry.stage))
    const available = Object.keys(draft.departments).filter((name) => !used.has(name))
    if (available.length === 0) {
      toast.show({ variant: "warning", message: "Every department already has a pipeline stage.", duration: 4000 })
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title="Add pipeline stage (department)"
        options={available.map((name) => ({ value: name, title: name }))}
        onSelect={(option) => {
          setDraft("pipeline", (stages) => [...stages, { stage: option.value }])
          dialog.clear()
        }}
      />
    ))
  }

  function save() {
    toast.show({
      variant: "warning",
      message:
        'Saving isn\'t wired yet: there is no write endpoint for organization.jsonc from the TUI (only the read-only "/file/content" route exists). Edit .kilo/organization.jsonc directly or use `northstar org init` from the CLI for now.',
      duration: 8000,
    })
  }

  function statusLine() {
    const current = status()
    if (current.kind === "loading") return { text: "Loading .kilo/organization.jsonc...", fg: theme.textMuted }
    if (current.kind === "loaded") return { text: "Loaded from .kilo/organization.jsonc", fg: theme.success }
    if (current.kind === "error") return { text: `Failed to parse organization.jsonc: ${current.message}`, fg: theme.error }
    return { text: "No organization.jsonc found — showing an in-memory skeleton", fg: theme.textMuted }
  }

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexDirection="column" width={36} flexShrink={0} paddingRight={2} gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Organization
        </text>
        <text fg={statusLine().fg}>{statusLine().text}</text>

        <box paddingLeft={1} onMouseUp={() => seed(blankSkeleton())}>
          <text fg={theme.text}>+ New: blank</text>
        </box>
        <box paddingLeft={1} onMouseUp={() => seed(sampleSkeleton())}>
          <text fg={theme.text}>+ New: sample (build → ship)</text>
        </box>
        <box paddingLeft={1} onMouseUp={reload}>
          <text fg={theme.text}>↻ Reload from file</text>
        </box>

        <text attributes={TextAttributes.BOLD} fg={theme.text} paddingTop={1}>
          Org chart
        </text>
        <scrollbox scrollbarOptions={{ visible: false }} flexGrow={1}>
          <box flexDirection="column">
            <text fg={theme.primary}>
              {draft.ceo} <span style={{ fg: theme.textMuted }}>ceo</span>
            </text>
            <For each={Object.entries(draft.departments)}>
              {([name, dept]) => (
                <box flexDirection="column" paddingLeft={2}>
                  <text fg={theme.text}>
                    {name}: {dept.chief} <span style={{ fg: theme.textMuted }}>chief</span>
                  </text>
                  <For each={dept.workers}>
                    {(worker) => (
                      <text fg={theme.textMuted} paddingLeft={2}>
                        - {worker}
                      </text>
                    )}
                  </For>
                </box>
              )}
            </For>
          </box>
        </scrollbox>
      </box>

      <box flexDirection="column" flexGrow={1} gap={1}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Pipeline
        </text>
        <box flexDirection="column">
          <For each={draft.pipeline}>
            {(stageEntry, index) => (
              <box flexDirection="row" gap={2} paddingLeft={1}>
                <text fg={theme.textMuted}>{index() + 1}.</text>
                <text fg={theme.text}>{stageEntry.stage}</text>
                <Show when={stageEntry.requires}>
                  <text fg={theme.textMuted}>requires: {(stageEntry.requires ?? []).join(", ")}</text>
                </Show>
                <text onMouseUp={() => toggleGate(index())} fg={stageEntry.gate === "human" ? theme.warning : theme.textMuted}>
                  [{stageEntry.gate === "human" ? "gate: human" : "no gate"}]
                </text>
                <text onMouseUp={() => moveStage(index(), -1)} fg={theme.textMuted}>
                  ▲
                </text>
                <text onMouseUp={() => moveStage(index(), 1)} fg={theme.textMuted}>
                  ▼
                </text>
              </box>
            )}
          </For>
          <box paddingLeft={1} onMouseUp={addStage}>
            <text fg={theme.accent}>+ Add stage</text>
          </box>
        </box>

        <text attributes={TextAttributes.BOLD} fg={theme.text} paddingTop={1}>
          Validation
        </text>
        <box flexDirection="column">
          <Show
            when={issues().length > 0}
            fallback={<text fg={theme.success}>Organization is valid (structural + agent cross-check).</text>}
          >
            <For each={issues()}>{(issue) => <text fg={theme.error}>- {issue}</text>}</For>
          </Show>
        </box>

        <box paddingLeft={1} paddingTop={1} onMouseUp={save}>
          <text fg={theme.textMuted}>Save (not wired — see status line above)</text>
        </box>
      </box>
    </box>
  )
}
