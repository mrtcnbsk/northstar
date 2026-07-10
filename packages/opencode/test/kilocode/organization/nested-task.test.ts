import { describe, test, expect } from "bun:test"
import { KiloTask } from "../../../src/kilocode/tool/task"
import { deriveSubagentSessionPermission } from "../../../src/agent/subagent-permissions"
import type { Agent } from "../../../src/agent/agent"

function agent(permission: Agent.Info["permission"]): Agent.Info {
  return { name: "x", mode: "subagent", permission, options: {} } as Agent.Info
}

// kilocode_change start - W1.0/W1.0b: declaredSubordinate gate tests (subordinates-keyed)
function namedAgent(name: string, permission: Agent.Info["permission"], subordinates?: string[]): Agent.Info {
  return { name, mode: "subagent", permission, options: {}, subordinates } as Agent.Info
}
// kilocode_change end

describe("KiloTask.nestedTask (W1.0b: keyed on declared subordinates, not the ruleset)", () => {
  test("false for a plain worker (no subordinates declared)", () => {
    expect(KiloTask.nestedTask(agent([]))).toBe(false)
  })

  test("false when the ruleset has task denies but no subordinates are declared", () => {
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "deny" }]))).toBe(false)
  })

  test("false for wildcard task rules (global config leak): no subordinates declared", () => {
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "ask" }]))).toBe(false)
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "allow" }]))).toBe(false)
  })

  test("false even for the old ruleset manager-signature: rules alone are not a declaration", () => {
    // W1.0b: a specific non-wildcard task allow used to mark a manager; now only the
    // author-declared subordinates list does. Global config can inject rules, not the list.
    expect(
      KiloTask.nestedTask(
        agent([
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "swiftui-dev-1", action: "allow" },
        ]),
      ),
    ).toBe(false)
  })

  test("true for a manager with a non-empty declared subordinates list", () => {
    expect(KiloTask.nestedTask(namedAgent("chief", [], ["swiftui-dev-1"]))).toBe(true)
  })

  test("false for an empty declared subordinates list", () => {
    expect(KiloTask.nestedTask(namedAgent("chief", [], []))).toBe(false)
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

// kilocode_change start - W1.0b: global deny-by-default task policy must not manufacture managers
describe("global task hardening cannot manufacture a manager (reviewer repro)", () => {
  // Reviewer repro: a user's global `permission: {task: {"*": "deny", "x": "allow"}}`
  // (legitimate hardening) merges LAST into every agent's ruleset. When manager detection
  // was keyed on the ruleset signature, this manufactured the manager signature on
  // built-ins like `explore` (which carry edit denies and are not name-gated), silently
  // relaxing edit-deny forwarding on that edge. Detection is now keyed on the declared
  // `subordinates` field, which global config cannot inject.
  const builtinLike = namedAgent("explore", [
    // defaults + built-in narrowing (explore shape: deny-by-default, read-only allows)
    { permission: "*", pattern: "*", action: "allow" },
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
    // user's global task hardening, merged last:
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "task", pattern: "x", action: "allow" },
  ])

  test("nestedTask is false: no declared subordinates", () => {
    expect(KiloTask.nestedTask(builtinLike)).toBe(false)
  })

  test("declaredSubordinate is false: no declared subordinates", () => {
    expect(KiloTask.declaredSubordinate(builtinLike, "x")).toBe(false)
  })

  test("edit-deny forwarding is NOT relaxed on that edge", () => {
    const worker = agent([])
    const session = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: builtinLike,
      subagent: worker,
    })
    expect(session.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
  })
})
// kilocode_change end

// kilocode_change start - W1.0/W1.0b: KiloTask.declaredSubordinate gate (subordinates-keyed)
describe("KiloTask.declaredSubordinate (W1.0b: exact-name match on declared subordinates)", () => {
  test("false when there is no parent", () => {
    expect(KiloTask.declaredSubordinate(undefined, "worker")).toBe(false)
  })

  test("false for plan-family parents even WITH declared subordinates (name gate, defense-in-depth)", () => {
    for (const name of ["plan", "ask", "architect", "Plan", "ASK"]) {
      const parent = namedAgent(name, [], ["general"])
      expect(KiloTask.declaredSubordinate(parent, "general"), `plan-family "${name}" must be refused`).toBe(false)
    }
  })

  test("false for a ruleset manager-signature without a declaration (global-config shapes)", () => {
    // Both global-config shapes: wildcard allow last, and deny-by-default + specific allow.
    const wildcardShape = namedAgent("chief", [
      { permission: "task", pattern: "*", action: "allow" },
      { permission: "task", pattern: "worker", action: "allow" },
    ])
    expect(KiloTask.declaredSubordinate(wildcardShape, "worker")).toBe(false)

    const signatureShape = namedAgent("chief", [
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "task", pattern: "worker", action: "allow" },
    ])
    expect(KiloTask.declaredSubordinate(signatureShape, "worker")).toBe(false)
  })

  test("false when the child is not in the declared list", () => {
    const parent = namedAgent("chief", [], ["other-worker"])
    expect(KiloTask.declaredSubordinate(parent, "worker")).toBe(false)
  })

  test("exact-name match only: no pattern semantics in subordinates entries", () => {
    const parent = namedAgent("chief", [], ["swiftui-*", "worker"])
    expect(KiloTask.declaredSubordinate(parent, "swiftui-dev-1")).toBe(false)
    expect(KiloTask.declaredSubordinate(parent, "worker")).toBe(true)
  })

  test("false for an empty child name", () => {
    const parent = namedAgent("chief", [], [""])
    expect(KiloTask.declaredSubordinate(parent, "")).toBe(false)
  })

  test("true when the parent declares the child by exact name", () => {
    const parent = namedAgent("chief", [], ["worker"])
    expect(KiloTask.declaredSubordinate(parent, "worker")).toBe(true)
  })
})

// W1.0b rec 3: PLAN_FAMILY must stay in sync with the planner names the codebase uses.
describe("PLAN_FAMILY sync with codebase planner names", () => {
  test("every PLANNERS name in src/kilocode/plan-file.ts (plus the ask built-in) is refused", async () => {
    // Authoritative source: the module-internal `PLANNERS = new Set([...])` literal in
    // src/kilocode/plan-file.ts (not exported), plus the read-only "ask" built-in defined
    // in src/kilocode/agent/index.ts. Parse the literal from source so this test fails
    // if a planner name is added there without updating PLAN_FAMILY in kilocode/tool/task.ts.
    const path = await import("path")
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../../../src/kilocode/plan-file.ts"),
    ).text()
    const match = source.match(/PLANNERS\s*=\s*new Set\(\[([^\]]*)\]\)/)
    expect(match, "PLANNERS literal must exist in src/kilocode/plan-file.ts").toBeTruthy()
    const planners = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(planners.length).toBeGreaterThan(0)

    for (const name of [...planners, "ask"]) {
      const parent = namedAgent(name, [], ["general"])
      expect(
        KiloTask.declaredSubordinate(parent, "general"),
        `planner "${name}" must be in PLAN_FAMILY (kilocode/tool/task.ts)`,
      ).toBe(false)
    }
  })
})
// kilocode_change end

describe("transitive permission ceiling across 3 levels (existing derive logic composes)", () => {
  test("a CEO edit deny survives CEO -> chief -> worker", () => {
    const ceo = agent([{ permission: "edit", pattern: "*", action: "deny" }])
    // kilocode_change - W1.0b: manager status now comes from the declared subordinates list;
    // the task rules stay because that's what the subordinates expansion emits for ask-time
    // spawn enforcement
    const chief = namedAgent(
      "chief",
      [
        { permission: "task", pattern: "*", action: "deny" },
        { permission: "task", pattern: "worker", action: "allow" },
      ],
      ["worker"],
    )
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
