// kilocode_change - Mission empty and completion states
import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { formatCost } from "./cockpit-view"
import type { MissionCompletion } from "./conversation"

export function MissionEmptyState(props: {
  organizationName: string
  departments: number
  agents: number
  onStart: () => void
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme.text}>{props.organizationName} is ready for its first mission.</text>
      <text fg={theme.textMuted}>
        {props.departments} departments · {props.agents} agents
      </text>
      <text fg={theme.primary} onMouseUp={props.onStart}>
        Start a mission →
      </text>
      <text fg={theme.textMuted}>enter Start a mission</text>
    </box>
  )
}

export function MissionCompletionState(props: { value: MissionCompletion; onReturn: () => void }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" flexShrink={0} border={["top"]} borderColor={theme.border} paddingTop={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.success}>
        {props.value.title}
      </text>
      <text fg={theme.textMuted}>
        {formatCost(props.value.totalCost)} · {props.value.elapsed}
      </text>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Final deliverables
      </text>
      <Show
        when={props.value.deliverables.length > 0}
        fallback={<text fg={theme.textMuted}>No deliverables recorded.</text>}
      >
        <For each={props.value.deliverables}>
          {(deliverable) => (
            <text fg={theme.textMuted}>
              {deliverable.stage}: {deliverable.path}
            </text>
          )}
        </For>
      </Show>
      <text fg={theme.primary} onMouseUp={props.onReturn}>
        {props.value.action} →
      </text>
      <text fg={theme.textMuted}>enter {props.value.action}</text>
    </box>
  )
}
