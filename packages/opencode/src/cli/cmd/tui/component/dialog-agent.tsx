import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
// kilocode_change start - Task 7.2: surface the org roster (see agent-roster.ts for why
// local.agent.list() alone isn't enough - it only carries primaries, so every org
// chief/worker except the CEO would be invisible here)
import { useSync } from "@tui/context/sync"
import { useToast } from "@tui/ui/toast"
import { buildAgentOptions } from "@/kilocode/cli/cmd/tui/agent-roster"
// kilocode_change end

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  // kilocode_change start - Task 7.2: group the FULL agent list (built-ins + org,
  // primaries + subagents) instead of just local.agent.list()'s primaries-only view.
  // Tab-cycle (local.agent.move) and local.agent.set()'s validation are intentionally
  // left untouched - they still only know about primaries - so org subagents are
  // visible here for discovery but not directly selectable; see onSelect below.
  const sync = useSync()
  const toast = useToast()

  const roster = createMemo(() => buildAgentOptions(sync.data.agent, local.agent.current()?.name))

  const options = createMemo(() =>
    roster().map((item) => {
      const raw = sync.data.agent.find((a) => a.name === item.name)
      const orgSubagentHint = item.mode === "subagent" && item.source === "organization" ? "@mention only" : undefined
      return {
        value: item.name,
        title: item.title,
        category: item.category,
        description:
          [raw?.deprecated && "deprecated", raw?.native && "native", orgSubagentHint].filter(Boolean).join(", ") ||
          item.description,
      }
    }),
  )
  // kilocode_change end

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current()?.name ?? ""} // kilocode_change
      options={options()}
      onSelect={(option) => {
        // kilocode_change start - org subagents are reached mid-run via @mention (Task
        // 7.3), not by switching the current agent, so intercept before local.agent.set()
        // (which would only fail with a generic "Agent not found" warning since it
        // validates against primaries).
        const found = roster().find((item) => item.name === option.value)
        if (found?.mode === "subagent" && found.source === "organization") {
          toast.show({
            variant: "info",
            message: `${found.title} is an org subagent - reach it mid-run with @${found.name}`,
            duration: 3000,
          })
          dialog.clear()
          return
        }
        // kilocode_change end
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
