// kilocode_change - Northstar Setup knowledge step
import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { SetupModel } from "./model"

export function KnowledgeStep(props: {
  draft: SetupModel.Draft
  onImport: () => void
  onRemove: (index: number) => void
}) {
  const { theme } = useTheme()
  const scopeName = (item: SetupModel.Knowledge) => {
    if (item.scope.type === "shared") return "Shared knowledge"
    return (
      props.draft.departments.find((department) => department.id === item.scope.departmentID)?.name ??
      item.scope.departmentID
    )
  }
  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Import managed knowledge
      </text>
      <text fg={theme.textMuted}>
        Northstar copies selected workspace files. Shared files reach every department; department files stay private.
      </text>
      <Show
        when={props.draft.knowledge.length}
        fallback={<text fg={theme.textMuted}>Knowledge is optional. You can add it later in Setup.</text>}
      >
        <For each={props.draft.knowledge}>
          {(item, index) => (
            <box flexDirection="column" paddingLeft={1}>
              <text fg={theme.text}>{scopeName(item)}</text>
              <For each={item.sources}>
                {(source) => (
                  <text fg={item.status[source] === "failed" ? theme.error : theme.textMuted} paddingLeft={2}>
                    {source} · {item.status[source]}
                  </text>
                )}
              </For>
              <text fg={theme.error} paddingLeft={2} onMouseUp={() => props.onRemove(index())}>
                Remove selection
              </text>
            </box>
          )}
        </For>
      </Show>
      <text fg={theme.primary} onMouseUp={props.onImport}>
        Import and read
      </text>
    </box>
  )
}
