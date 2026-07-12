// kilocode_change - new file
/**
 * Builder full-screen view
 *
 * Main layout component for the /builder route. Renders a left-hand section
 * nav (Models / Agents / Organization) and a right-hand content panel.
 * Escape navigates back to the previous route.
 *
 * Models (Task 6.1) is a real screen (`ModelsScreen`); Agents/Organization
 * remain stubs until Task 6.2/6.3 replace them.
 */

import { createSignal, createMemo, Switch, Match } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"
import { ModelsScreen } from "./models-screen"

type Section = "models" | "agents" | "organization"

export function BuilderView() {
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()

  const [section, setSection] = createSignal<Section>(
    route.data.type === "builder" && route.data.section ? route.data.section : "models",
  )

  const builderCommands = createMemo(() => [
    {
      namespace: "palette",
      name: "builder.back",
      title: "Back",
      desc: "Return to the previous view",
      category: "Builder",
      run: () => {
        dialog.clear()
        route.back()
      },
    },
    {
      namespace: "palette",
      name: "builder.models",
      title: "Models",
      desc: "Show the Models section",
      category: "Builder",
      run: () => setSection("models"),
    },
    {
      namespace: "palette",
      name: "builder.agents",
      title: "Agents",
      desc: "Show the Agents section",
      category: "Builder",
      run: () => setSection("agents"),
    },
    {
      namespace: "palette",
      name: "builder.organization",
      title: "Organization",
      desc: "Show the Organization section",
      category: "Builder",
      run: () => setSection("organization"),
    },
  ])

  useBindings(() => ({
    commands: builderCommands(),
    bindings: [
      { key: "escape", cmd: "builder.back" },
      { key: "1", cmd: "builder.models" },
      { key: "2", cmd: "builder.agents" },
      { key: "3", cmd: "builder.organization" },
    ],
  }))

  const navItem = (label: string, value: Section) => (
    <text fg={section() === value ? theme.primary : theme.textMuted}>{label}</text>
  )

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexDirection="column" paddingLeft={2} paddingTop={1} gap={1}>
        {navItem("Models", "models")}
        {navItem("Agents", "agents")}
        {navItem("Organization", "organization")}
      </box>
      <box flexGrow={1} paddingLeft={2} paddingTop={1}>
        <Switch>
          <Match when={section() === "models"}>
            <ModelsScreen />
          </Match>
          <Match when={section() === "agents"}>
            <box>
              <text fg={theme.textMuted}>Agents — coming in 6.2</text>
            </box>
          </Match>
          <Match when={section() === "organization"}>
            <box>
              <text fg={theme.textMuted}>Organization — coming in 6.3</text>
            </box>
          </Match>
        </Switch>
      </box>
    </box>
  )
}
