// kilocode_change - Northstar Setup departments step
import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { SetupModel } from "./model"

export function DepartmentsStep(props: {
  draft: SetupModel.Draft
  onAdd: () => void
  onEdit: (id: string) => void
  onRemove: (id: string) => void
}) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Build departments
      </text>
      <text fg={theme.textMuted}>Each department owns a focused mission, one lead, and its specialists.</text>
      <Show when={props.draft.departments.length} fallback={<text fg={theme.warning}>No departments yet.</text>}>
        <For each={props.draft.departments}>
          {(department) => (
            <box flexDirection="column" paddingLeft={1} onMouseUp={() => props.onEdit(department.id)}>
              <text fg={theme.text}>
                {department.name} <span style={{ fg: theme.textMuted }}>{department.id}</span>
              </text>
              <text fg={theme.textMuted} paddingLeft={2}>
                {department.mission}
              </text>
              <text fg={theme.textMuted} paddingLeft={2}>
                Lead: {department.chief || "not assigned"} · Specialists: {department.workers.length}
              </text>
              <text fg={theme.error} paddingLeft={2} onMouseUp={() => props.onRemove(department.id)}>
                Remove department
              </text>
            </box>
          )}
        </For>
      </Show>
      <text fg={theme.primary} onMouseUp={props.onAdd}>
        + Add department
      </text>
    </box>
  )
}
