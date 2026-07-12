// kilocode_change - new file
// Task 7.2 (EPIC 7 / TUI Chat): surface the org roster in the agent selector.
//
// Org agents already flow into sync.data.agent (source: "organization", displayName,
// subordinates, mode) - see the org-template contract in
// test/kilocode/organization/templates.test.ts, which pins the CEO as the only
// mode:"primary" agent and every chief/worker as mode:"subagent". local.agent.list()
// (src/cli/cmd/tui/context/local.tsx) filters out every mode:"subagent" agent, which is
// correct for the Tab-cycle (only primaries make sense to cycle through) but means the
// whole org roster is invisible in the agent picker dialog.
//
// buildAgentOptions is the pure grouping core used to render that dialog: it takes the
// FULL agent list (sync.data.agent) and buckets it into "Built-in" (source == null -
// native commands plus any plain config agents) and "Org" (source === "organization"),
// preserving input order within each group and excluding hidden agents. It does not
// decide selectability - dialog-agent.tsx decides what happens when an option is
// chosen.
import type { Agent } from "@kilocode/sdk/v2"
import { Locale } from "@/util/locale"

export interface AgentOption {
  category: string
  name: string
  title: string
  description?: string
  source?: string
  mode?: string
}

export const AGENT_ROSTER_CATEGORY_BUILTIN = "Built-in"
export const AGENT_ROSTER_CATEGORY_ORG = "Org"

export function buildAgentOptions(agents: Agent[], current?: string): AgentOption[] {
  // kilocode_change - `current` is accepted for signature parity with callers that track
  // a currently-selected agent (mirrors DialogSelect's own `current` prop), but grouping
  // itself is current-independent: which bucket an agent falls into never depends on
  // what's currently selected. Selection highlighting is DialogSelect's job.
  void current

  const builtin: AgentOption[] = []
  const org: AgentOption[] = []

  for (const agent of agents) {
    if (agent.hidden) continue

    const option: AgentOption = {
      category: "",
      name: agent.name,
      title: agent.displayName ?? Locale.titlecase(agent.name),
      description: agent.description,
      source: agent.source,
      mode: agent.mode,
    }

    if (agent.source === "organization") {
      option.category = AGENT_ROSTER_CATEGORY_ORG
      org.push(option)
    } else if (agent.source == null) {
      option.category = AGENT_ROSTER_CATEGORY_BUILTIN
      builtin.push(option)
    }
    // kilocode_change - agents with a source other than "organization" (e.g. future
    // plugin-provided sources) are neither built-in nor org; they're intentionally
    // excluded rather than silently mis-bucketed until a category is defined for them.
  }

  return [...builtin, ...org]
}
