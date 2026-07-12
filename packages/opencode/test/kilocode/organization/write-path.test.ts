// packages/opencode/test/kilocode/organization/write-path.test.ts
//
// W1.0 — composed-seam matrix pinning the full org write path (CEO -> chief -> worker).
//
// Loads the REAL org-template agent files (same pattern as template.test.ts), builds
// Agent.Info-shaped rulesets the same way the real Agent service does (defaults stand-in
// + Permission.fromConfig(agent.permission)), then composes child SESSION permission
// exactly as src/tool/task.ts:193-233 does for a fresh spawn:
//
//   rules = KiloTask.inherited({ caller, session: parent, mcp })
//   childSessionPermission = KiloTask.merge(
//     deriveSubagentSessionPermission({ parentSessionPermission, parentAgent, subagent }),
//     primary_tools rules (none here),
//     KiloTask.permissions(rules, { canTask }),
//   )
//
// Effective evaluation at the child = merge(childAgent.permission, childSessionPermission),
// mirroring session/prompt.ts and plan-mode-subagent-bypass.test.ts.
import { describe, test, expect } from "bun:test"
import path from "path"
import * as ConfigAgent from "../../../src/config/agent"
import { Permission } from "../../../src/permission"
import { deriveSubagentSessionPermission } from "../../../src/agent/subagent-permissions"
import { KiloTask } from "../../../src/kilocode/tool/task"
import type { Agent } from "../../../src/agent/agent"

const TEMPLATE = path.resolve(import.meta.dir, "../../../../..", "templates", "ios-app-factory")

// Defaults stand-in: mirrors baseDefaults in src/agent/agent.ts ("*": "allow" first rule).
const DEFAULTS: Permission.Ruleset = Permission.fromConfig({ "*": "allow" })

async function loadTemplateAgents() {
  return ConfigAgent.load(TEMPLATE)
}

function buildAgent(name: string, raw: ConfigAgent.Info): Agent.Info {
  return {
    name,
    mode: raw.mode,
    permission: Permission.merge(DEFAULTS, Permission.fromConfig(raw.permission ?? {})),
    options: {},
    // kilocode_change - W1.0b: manager detection keys on the declared subordinates list;
    // mirror the runtime merge loop in src/agent/agent.ts threading it onto Agent.Info
    subordinates: raw.subordinates,
  } as Agent.Info
}

/** Compose a fresh child SESSION permission exactly as src/tool/task.ts:213-234 does. */
function spawnChildSession(input: {
  parentAgent: Agent.Info | undefined
  parentSessionPermission: Permission.Ruleset
  caller: Agent.Info
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = KiloTask.nestedTask(input.subagent)
  const rules = KiloTask.inherited({
    caller: input.caller,
    session: { permission: input.parentSessionPermission } as never,
    mcp: {},
    subagent: input.subagent,
  })
  return KiloTask.merge(
    deriveSubagentSessionPermission({
      parentSessionPermission: input.parentSessionPermission,
      parentAgent: input.parentAgent,
      subagent: input.subagent,
    }),
    KiloTask.permissions(rules, { canTask }),
  )
}

function effective(agent: Agent.Info, sessionPermission: Permission.Ruleset): Permission.Ruleset {
  return Permission.merge(agent.permission, sessionPermission)
}

describe("W1.0 composed-seam matrix: CEO -> chief -> worker write path", () => {
  test("setup: template loads chief + worker fixtures", async () => {
    const agents = await loadTemplateAgents()
    expect(agents["ceo"]).toBeTruthy()
    expect(agents["backend-chief"]).toBeTruthy()
    expect(agents["data-layer-dev"]).toBeTruthy()
    expect(agents["apple-docs"]).toBeTruthy()
  })

  // ---- hop 1: CEO (primary, no parent) spawns backend-chief -------------------------

  test("1. chief edit deliverable path -> allow", async () => {
    const raw = await loadTemplateAgents()
    const ceo = buildAgent("ceo", raw["ceo"])
    const chief = buildAgent("backend-chief", raw["backend-chief"])

    // Root spawn: CEO has no parent session/agent of its own (it's the primary entrypoint).
    // caller === ceo (ctx.agent for the CEO's own turn spawning the task tool).
    const chiefSessionPermission = spawnChildSession({
      parentAgent: undefined,
      parentSessionPermission: [],
      caller: ceo,
      subagent: chief,
    })
    const eff = effective(chief, chiefSessionPermission)
    const rel = ".kilo/org/runs/20260710-120000-idea/deliverables/evaluation.md"
    expect(Permission.evaluate("edit", rel, eff).action).toBe("allow")
  })

  test("2. chief edit state.json + approvals.json -> deny", async () => {
    const raw = await loadTemplateAgents()
    const ceo = buildAgent("ceo", raw["ceo"])
    const chief = buildAgent("backend-chief", raw["backend-chief"])

    const chiefSessionPermission = spawnChildSession({
      parentAgent: undefined,
      parentSessionPermission: [],
      caller: ceo,
      subagent: chief,
    })
    const eff = effective(chief, chiefSessionPermission)
    expect(Permission.evaluate("edit", ".kilo/org/runs/x/state.json", eff).action).toBe("deny")
    expect(Permission.evaluate("edit", ".kilo/org/runs/x/approvals.json", eff).action).toBe("deny")
  })

  test("3. chief edit Sources/App/Main.swift -> deny", async () => {
    const raw = await loadTemplateAgents()
    const ceo = buildAgent("ceo", raw["ceo"])
    const chief = buildAgent("backend-chief", raw["backend-chief"])

    const chiefSessionPermission = spawnChildSession({
      parentAgent: undefined,
      parentSessionPermission: [],
      caller: ceo,
      subagent: chief,
    })
    const eff = effective(chief, chiefSessionPermission)
    expect(Permission.evaluate("edit", "Sources/App/Main.swift", eff).action).toBe("deny")
  })

  test("4. chief bash denied; Permission.disabled -> bash disabled, edit/write NOT disabled", async () => {
    const raw = await loadTemplateAgents()
    const ceo = buildAgent("ceo", raw["ceo"])
    const chief = buildAgent("backend-chief", raw["backend-chief"])

    const chiefSessionPermission = spawnChildSession({
      parentAgent: undefined,
      parentSessionPermission: [],
      caller: ceo,
      subagent: chief,
    })
    const eff = effective(chief, chiefSessionPermission)
    expect(Permission.evaluate("bash", "swift build", eff).action).toBe("deny")

    const disabled = Permission.disabled(["edit", "write", "bash"], eff)
    expect(disabled.has("bash")).toBe(true)
    expect(disabled.has("edit")).toBe(false)
    expect(disabled.has("write")).toBe(false)
  })

  // ---- hop 2: backend-chief spawns data-layer-dev ------------------------------------

  function spawnHop2() {
    return (async () => {
      const raw = await loadTemplateAgents()
      const ceo = buildAgent("ceo", raw["ceo"])
      const chief = buildAgent("backend-chief", raw["backend-chief"])
      const worker = buildAgent("data-layer-dev", raw["data-layer-dev"])
      const appleDocs = buildAgent("apple-docs", raw["apple-docs"])

      const chiefSessionPermission = spawnChildSession({
        parentAgent: undefined,
        parentSessionPermission: [],
        caller: ceo,
        subagent: chief,
      })

      const workerSessionPermission = spawnChildSession({
        parentAgent: chief,
        parentSessionPermission: chiefSessionPermission,
        caller: chief,
        subagent: worker,
      })

      const appleDocsSessionPermission = spawnChildSession({
        parentAgent: chief,
        parentSessionPermission: chiefSessionPermission,
        caller: chief,
        subagent: appleDocs,
      })

      return { chief, worker, appleDocs, chiefSessionPermission, workerSessionPermission, appleDocsSessionPermission }
    })()
  }

  test("5. hop-2 worker edit Sources/... -> allow; bash swift build -> allow", async () => {
    const { worker, workerSessionPermission } = await spawnHop2()
    const eff = effective(worker, workerSessionPermission)
    expect(Permission.evaluate("edit", "Sources/App/Model.swift", eff).action).toBe("allow")
    expect(Permission.evaluate("bash", "swift build --target App", eff).action).toBe("allow")
  })

  test("6. hop-2 worker edit .kilo/org/runs/x/state.json -> deny", async () => {
    const { worker, workerSessionPermission } = await spawnHop2()
    const eff = effective(worker, workerSessionPermission)
    expect(Permission.evaluate("edit", ".kilo/org/runs/x/state.json", eff).action).toBe("deny")
  })

  test("7. hop-2 worker task '*' -> deny; bash curl -> deny", async () => {
    const { worker, workerSessionPermission } = await spawnHop2()
    const eff = effective(worker, workerSessionPermission)
    expect(Permission.evaluate("task", "*", eff).action).toBe("deny")
    expect(Permission.evaluate("bash", "curl http://x", eff).action).toBe("deny")
  })

  test("8. hop-2 apple-docs edit anywhere -> deny", async () => {
    const { appleDocs, appleDocsSessionPermission } = await spawnHop2()
    const eff = effective(appleDocs, appleDocsSessionPermission)
    expect(Permission.evaluate("edit", "Sources/App/Model.swift", eff).action).toBe("deny")
    expect(Permission.evaluate("edit", ".kilo/org/runs/x/deliverables/evaluation.md", eff).action).toBe("deny")
  })

  // ---- gate refusal cases -------------------------------------------------------------

  test("9. plan-family parent (even with a declared subordinates list) spawning general -> edit still denied", async () => {
    // A plan-family agent (name "plan") must NOT get relaxation even when it carries BOTH
    // a declared subordinates list AND the manager-shaped task rules: parent AGENT denies
    // (edit) must still forward to the child session. kilocode_change - W1.0b: subordinates
    // added to the fixture so this exercises the PLAN_FAMILY name gate itself, not just
    // the missing-declaration gate.
    const planLike: Agent.Info = {
      name: "plan",
      mode: "primary",
      permission: Permission.merge(
        DEFAULTS,
        Permission.fromConfig({
          edit: "deny",
          task: {
            "*": "deny",
            general: "allow",
          },
        }),
      ),
      options: {},
      subordinates: ["general"],
    } as Agent.Info
    const general: Agent.Info = {
      name: "general",
      mode: "subagent",
      permission: Permission.merge(DEFAULTS, Permission.fromConfig({})),
      options: {},
    } as Agent.Info

    const childSessionPermission = spawnChildSession({
      parentAgent: planLike,
      parentSessionPermission: [],
      caller: planLike,
      subagent: general,
    })
    const eff = effective(general, childSessionPermission)
    expect(Permission.evaluate("edit", "/some/file.ts", eff).action).toBe("deny")
  })

  test("10. non-plan parent with task rules but NO declared subordinates (global-config shape) -> no relaxation", async () => {
    // Global user config merges task rules into every agent — wildcard allows AND
    // deny-by-default maps with specific allows. kilocode_change - W1.0b: detection keys on
    // the declared subordinates list, which global config cannot inject; a parent without
    // one gets no relaxation no matter what its task ruleset looks like.
    const parent: Agent.Info = {
      name: "custom-parent",
      mode: "primary",
      permission: Permission.merge(
        DEFAULTS,
        Permission.fromConfig({
          edit: "deny",
          task: {
            "*": "allow",
            specific: "allow",
          },
        }),
      ),
      options: {},
    } as Agent.Info
    const child: Agent.Info = {
      name: "specific",
      mode: "subagent",
      permission: Permission.merge(DEFAULTS, Permission.fromConfig({})),
      options: {},
    } as Agent.Info

    const childSessionPermission = spawnChildSession({
      parentAgent: parent,
      parentSessionPermission: [],
      caller: parent,
      subagent: child,
    })
    const eff = effective(child, childSessionPermission)
    expect(Permission.evaluate("edit", "/some/file.ts", eff).action).toBe("deny")
  })
})
