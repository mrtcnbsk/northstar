// kilocode_change - Northstar Setup agents step
import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { SetupModel } from "./model"

export function AgentsStep(props: {
  draft: SetupModel.Draft
  onAdd: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { theme } = useTheme()
  const layer = (id: SetupModel.LayerID) => props.draft.layers[id].name
  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Create agents
      </text>
      <text fg={theme.textMuted}>Assign role, behavior, model, permissions, layer, and department.</text>
      <Show when={props.draft.agents.length} fallback={<text fg={theme.warning}>No agents yet.</text>}>
        <For each={props.draft.agents}>
          {(agent) => (
            <box flexDirection="column" paddingLeft={1} onMouseUp={() => props.onEdit(agent.id)}>
              <text fg={theme.text}>
                {agent.name} <span style={{ fg: theme.textMuted }}>{agent.id}</span>
              </text>
              <text fg={theme.textMuted} paddingLeft={2}>
                {layer(agent.layer)}
                {agent.departmentID ? ` · ${agent.departmentID}` : ""}
              </text>
              <text fg={theme.textMuted} paddingLeft={2}>
                {agent.providerID}/{agent.modelID} · {agent.role}
              </text>
              <text fg={theme.error} paddingLeft={2} onMouseUp={() => props.onRemove(agent.id)}>
                Remove agent
              </text>
            </box>
          )}
        </For>
      </Show>
      <text fg={theme.primary} onMouseUp={props.onAdd}>
        + Add agent
      </text>
    </box>
  )
}
