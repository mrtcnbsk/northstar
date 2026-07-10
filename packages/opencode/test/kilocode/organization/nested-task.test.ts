import { describe, test, expect } from "bun:test"
import { KiloTask } from "../../../src/kilocode/tool/task"
import { deriveSubagentSessionPermission } from "../../../src/agent/subagent-permissions"
import type { Agent } from "../../../src/agent/agent"

function agent(permission: Agent.Info["permission"]): Agent.Info {
  return { name: "x", mode: "subagent", permission, options: {} } as Agent.Info
}

describe("KiloTask.nestedTask", () => {
  test("false for a plain worker (no task rules)", () => {
    expect(KiloTask.nestedTask(agent([]))).toBe(false)
  })

  test("false when the only task rules are denies", () => {
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "deny" }]))).toBe(false)
  })

  test("false when the only non-deny task rule is wildcard (global config leak)", () => {
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "ask" }]))).toBe(false)
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "allow" }]))).toBe(false)
  })

  test("true for a manager with a task allow rule", () => {
    expect(
      KiloTask.nestedTask(
        agent([
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "swiftui-dev-1", action: "allow" },
        ]),
      ),
    ).toBe(true)
  })
})

describe("KiloTask.permissions", () => {
  test("default: prepends task deny (workers)", () => {
    const rules = KiloTask.permissions([])
    expect(rules.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)
  })

  test("canTask: omits the task deny but keeps question/interactive_terminal denies", () => {
    const rules = KiloTask.permissions([], { canTask: true })
    expect(rules.some((r) => r.permission === "task")).toBe(false)
    expect(rules.some((r) => r.permission === "question" && r.action === "deny")).toBe(true)
    expect(rules.some((r) => r.permission === "interactive_terminal" && r.action === "deny")).toBe(true)
  })
})

describe("deriveSubagentSessionPermission canTask (unified on KiloTask.nestedTask)", () => {
  // kilocode_change start - before the unification, deriveSubagentSessionPermission treated ANY
  // task rule (even a wildcard-only ask, which is just the global config leaking into every
  // agent's ruleset) as canTask=true and omitted the task deny. Now it defers to the same
  // stricter, non-deny + non-wildcard predicate KiloTask.nestedTask uses, so a wildcard-only
  // agent gets the task deny here too.
  test("agent with only a wildcard {task,*,ask} rule now receives the task deny", () => {
    const wildcardAskOnly = agent([{ permission: "task", pattern: "*", action: "ask" }])
    expect(KiloTask.nestedTask(wildcardAskOnly)).toBe(false)

    const session = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: undefined,
      subagent: wildcardAskOnly,
    })
    expect(session.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)
  })
  // kilocode_change end
})

describe("transitive permission ceiling across 3 levels (existing derive logic composes)", () => {
  test("a CEO edit deny survives CEO -> chief -> worker", () => {
    const ceo = agent([{ permission: "edit", pattern: "*", action: "deny" }])
    const chief = agent([
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "task", pattern: "worker", action: "allow" },
    ])
    const worker = agent([])

    // hop 1: CEO spawns chief — chief session inherits CEO's edit deny, no task deny (manager)
    const chiefSession = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: ceo,
      subagent: chief,
    })
    expect(chiefSession.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
    expect(chiefSession.some((r) => r.permission === "task" && r.action === "deny")).toBe(false)

    // hop 2: chief spawns worker — the CEO deny still forwards; the worker gets the task deny back
    const workerSession = deriveSubagentSessionPermission({
      parentSessionPermission: chiefSession,
      parentAgent: chief,
      subagent: worker,
    })
    expect(workerSession.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
    expect(workerSession.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)
  })
})
