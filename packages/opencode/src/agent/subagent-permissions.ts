import type { Permission } from "../permission"
import type { Agent } from "./agent"
import { KiloTask } from "../kilocode/tool/task" // kilocode_change - unify canTask on the stricter nestedTask predicate

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514) kilocode_change - W1.0: skipped entirely on a
 *    declared-subordinate edge (KiloTask.declaredSubordinate) so a manager's own
 *    edit-deny does not forward onto the children it explicitly manages.
 * 2. The parent **session's** deny rules and external_directory rules —
 *    same forwarding the original code already did.
 * 3. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  // kilocode_change - unified on KiloTask.nestedTask: delegation requires an author-declared
  // `subordinates` list (W1.0b re-key), so ruleset-only shapes (global config task maps,
  // deny-only/wildcard-only rules) always get the task deny below
  const canTask = KiloTask.nestedTask(input.subagent)
  // kilocode_change end
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  // kilocode_change start - W1.0: declared-subordinate deny relaxation (restores org write path)
  // A parent whose author-declared `subordinates` list contains this child by EXACT name
  // (see KiloTask.declaredSubordinate — W1.0b re-keyed detection off the ruleset signature,
  // which a global deny-by-default task policy could manufacture on built-ins) does not
  // forward its AGENT-level edit denies onto this child's session. Without this, a chief's
  // `edit: deny "*"` (which exists so the CHIEF itself cannot write app code) forwarded as a
  // "*" deny into every worker session and findLast-beat the worker's own edit allow, since
  // session rules are appended after the agent ruleset at evaluation time. Plan Mode and
  // ordinary (non-manager) parents are unaffected: their AGENT denies still forward below.
  const parentAgentDenies = KiloTask.declaredSubordinate(input.parentAgent, input.subagent.name)
    ? []
    : (input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? [])
  // kilocode_change end
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
