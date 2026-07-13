// kilocode_change - persistent Northstar organization and tab navigation
import { createMemo } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useRoute } from "@tui/context/route"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useTheme } from "@tui/context/theme"
import { useTuiConfig } from "@tui/context/tui-config"
import { KILO_BASE_MODE, useBindings, useOpencodeKeymap } from "@tui/keymap"
import { useWorkspace } from "./context"

const COMMANDS = ["northstar.setup", "northstar.chat", "northstar.mission", "northstar.organization"] as const

export function WorkspaceHeader() {
  const route = useRoute()
  const workspace = useWorkspace()
  const dialog = useDialog()
  const keymap = useOpencodeKeymap()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()

  function openSetup() {
    const active = workspace.active()
    route.navigate(active ? { type: "setup", organizationID: active.id } : { type: "setup" })
  }

  function openChat() {
    route.navigate({ type: "home" })
  }

  function openMission() {
    if (!workspace.active()) return
    route.navigate({ type: "cockpit" })
  }

  function openOrganizationSelector() {
    dialog.replace(() => (
      <DialogSelect
        title="Switch organization"
        options={[
          ...workspace.data.organizations.map((organization) => ({
            value: organization.id,
            title: organization.name,
            description: organization.valid
              ? organization.id === workspace.data.active
                ? "Active"
                : "Ready"
              : "Repair required",
          })),
          { value: "__new__", title: "+ New organization", description: "Open a clean Setup draft" },
        ]}
        onSelect={(option) => {
          dialog.clear()
          if (option.value === "__new__") {
            route.navigate({ type: "setup" })
            return
          }
          void workspace
            .select(option.value)
            .then(() => route.navigate({ type: "cockpit" }))
            .catch(() => undefined)
        }}
      />
    ))
  }

  const commands = createMemo(() => [
    { name: "northstar.setup", title: "Open Setup", category: "Northstar", run: openSetup },
    { name: "northstar.chat", title: "Open Chat", category: "Northstar", run: openChat },
    { name: "northstar.mission", title: "Open Mission", category: "Northstar", run: openMission },
    {
      name: "northstar.organization",
      title: "Switch organization",
      category: "Northstar",
      run: openOrganizationSelector,
    },
  ])

  useBindings(() => ({ commands: commands() }))
  useBindings(() => ({
    mode: KILO_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("northstar", COMMANDS),
  }))

  const activeTab = () => {
    if (route.data.type === "setup") return "setup"
    if (route.data.type === "cockpit") return "mission"
    if (route.data.type === "home" || route.data.type === "session") return "chat"
    return ""
  }
  const tab = (label: string, value: "setup" | "chat" | "mission", command: (typeof COMMANDS)[number]) => (
    <text
      attributes={activeTab() === value ? TextAttributes.BOLD : undefined}
      fg={activeTab() === value ? theme.primary : theme.textMuted}
      onMouseUp={() => keymap.dispatchCommand(command)}
    >
      {activeTab() === value ? "● " : "  "}
      {label}
    </text>
  )

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <box flexDirection="row" gap={2}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            NORTHSTAR
          </text>
          <text fg={theme.primary} onMouseUp={() => keymap.dispatchCommand("northstar.organization")}>
            {workspace.active()?.name ?? "No organization"} ▾
          </text>
        </box>
        <box flexDirection="row" gap={3}>
          {tab("Setup", "setup", "northstar.setup")}
          {tab("Chat", "chat", "northstar.chat")}
          {tab("Mission", "mission", "northstar.mission")}
        </box>
      </box>
      <box flexDirection="row" justifyContent="flex-end" gap={2} paddingRight={2}>
        <text fg={theme.textMuted}>ctrl+x o Organization</text>
        <text fg={theme.textMuted}>ctrl+x s Setup</text>
        <text fg={theme.textMuted}>ctrl+x c Chat</text>
        <text fg={theme.textMuted}>ctrl+x m Mission</text>
      </box>
    </box>
  )
}
