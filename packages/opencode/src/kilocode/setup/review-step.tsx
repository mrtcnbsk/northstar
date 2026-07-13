// kilocode_change - Northstar Setup review step
import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { SetupModel } from "./model"

export function ReviewStep(props: {
  draft: SetupModel.Draft
  issues: string[]
  busy: boolean
  edit: boolean
  onSubmit: () => void
}) {
  const { theme } = useTheme()
  const knowledgeCount = () => props.draft.knowledge.reduce((count, item) => count + item.sources.length, 0)
  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Review and create
      </text>
      <text fg={theme.text}>{props.draft.name}</text>
      <text fg={theme.textMuted}>
        {props.draft.departments.length} departments · {props.draft.agents.length} agents · {knowledgeCount()} knowledge
        files
      </text>
      <For each={props.draft.departments}>
        {(department) => (
          <text fg={theme.text} paddingLeft={1}>
            {department.name}: {department.chief || "no lead"} → {department.workers.join(", ") || "no specialists"}
          </text>
        )}
      </For>
      <Show when={props.issues.length} fallback={<text fg={theme.success}>Ready to publish.</text>}>
        <text fg={theme.error}>Resolve these issues:</text>
        <For each={props.issues}>
          {(issue) => (
            <text fg={theme.error} paddingLeft={1}>
              - {issue}
            </text>
          )}
        </For>
      </Show>
      <text
        fg={props.issues.length || props.busy ? theme.textMuted : theme.primary}
        onMouseUp={() => !props.issues.length && !props.busy && props.onSubmit()}
      >
        {props.busy ? "Saving..." : props.edit ? "Save changes" : "Create organization"}
      </text>
    </box>
  )
}
