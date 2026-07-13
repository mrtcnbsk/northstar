// kilocode_change - Northstar Setup organization step
import { For } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { SetupModel } from "./model"

export function OrganizationStep(props: {
  draft: SetupModel.Draft
  onEditName: () => void
  onEditLayer: (layer: SetupModel.LayerID) => void
}) {
  const { theme } = useTheme()
  const layers = () =>
    Object.entries(props.draft.layers) as Array<[SetupModel.LayerID, { name: string; mission: string }]>
  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Create your organization
      </text>
      <text fg={theme.textMuted}>Name the organization and define the mission of each fixed hierarchy layer.</text>
      <box paddingLeft={1} onMouseUp={props.onEditName}>
        <text fg={theme.primary}>Organization {props.draft.name}</text>
      </box>
      <For each={layers()}>
        {([id, layer]) => (
          <box flexDirection="column" paddingLeft={1} onMouseUp={() => props.onEditLayer(id)}>
            <text fg={theme.text}>{layer.name}</text>
            <text fg={theme.textMuted} paddingLeft={2}>
              {layer.mission}
            </text>
          </box>
        )}
      </For>
      <text fg={theme.textMuted}>Select a row to edit it. The hierarchy always remains three layers deep.</text>
    </box>
  )
}
