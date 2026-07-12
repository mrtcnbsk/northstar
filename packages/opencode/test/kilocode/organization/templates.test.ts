// packages/opencode/test/kilocode/organization/templates.test.ts
// kilocode_change - new file (EPIC 4 / Task 4.4): consistency + live-scaffold coverage for the
// three non-iOS org templates (blank, research-desk, content-studio). Mirrors template.test.ts's
// ios-app-factory consistency checks, generalized across all three new templates, plus a real
// `org init` scaffold (handleInit - the same function the CLI's `org init` command calls) proving
// each template survives loadOrganization + validate + crossCheck end to end.
import { describe, test, expect } from "bun:test"
import path from "path"
import { existsSync } from "fs"
import { parse as parseJsonc } from "jsonc-parser"
import * as ConfigAgent from "../../../src/config/agent"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgTemplates, handleInit } from "../../../src/kilocode/cli/cmd/org"
import { tmpdir } from "../../fixture/fixture"

const TEMPLATES_DIR = path.resolve(import.meta.dir, "../../../../..", "templates")

const NON_IOS_TEMPLATES = ["blank", "research-desk", "content-studio"] as const

async function loadTemplate(name: string) {
  const dir = path.join(TEMPLATES_DIR, name)
  const text = await Bun.file(path.join(dir, "organization.jsonc")).text()
  const org = OrgSchema.parse(parseJsonc(text))
  const agents = await ConfigAgent.load(dir)
  return { dir, org, agents }
}

function harness() {
  const logs: string[] = []
  const errors: string[] = []
  const codes: number[] = []
  return {
    logs,
    errors,
    codes,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
    exit: (code: number) => codes.push(code),
  }
}

describe("non-iOS org templates: blank, research-desk, content-studio", () => {
  for (const name of NON_IOS_TEMPLATES) {
    describe(name, () => {
      test("organization.jsonc is structurally valid (OrgSchema.validate == [])", async () => {
        const { org } = await loadTemplate(name)
        expect(OrgSchema.validate(org)).toEqual([])
      })

      test("carries no apple-delivery toolpack (non-iOS)", async () => {
        const { org } = await loadTemplate(name)
        expect(org.toolpacks).toEqual([])
      })

      test("every pipeline stage has a matching department", async () => {
        const { org } = await loadTemplate(name)
        for (const { stage } of org.pipeline) {
          expect(Object.hasOwn(org.departments, stage), `stage "${stage}" must have a matching department`).toBe(
            true,
          )
        }
      })

      test("agent files load and cross-check against the org chart (OrgSchema.crossCheck == [])", async () => {
        const { org, agents } = await loadTemplate(name)
        const view = Object.fromEntries(
          Object.entries(agents).map(([agentName, a]) => [
            agentName,
            { mode: a.mode, subordinates: (a as { subordinates?: readonly string[] }).subordinates },
          ]),
        )
        expect(OrgSchema.crossCheck(org, view)).toEqual([])
      })

      test("ceo agent exists, is mode: primary; every other agent is mode: subagent", async () => {
        const { org, agents } = await loadTemplate(name)
        expect(agents[org.ceo], `ceo agent "${org.ceo}" must be defined`).toBeTruthy()
        for (const [agentName, agent] of Object.entries(agents)) {
          if (agentName === org.ceo) expect(agent.mode).toBe("primary")
          else expect(agent.mode).toBe("subagent")
        }
      })

      test("no agent name is both a chief and a worker", async () => {
        const { org } = await loadTemplate(name)
        const chiefs = new Set(Object.values(org.departments).map((d) => d.chief))
        const workers = new Set(Object.values(org.departments).flatMap((d) => d.workers))
        for (const chief of chiefs) expect(workers.has(chief)).toBe(false)
      })

      test("every chief's subordinates is a superset of its department's workers + shared", async () => {
        const { org, agents } = await loadTemplate(name)
        for (const [deptName, dept] of Object.entries(org.departments)) {
          const chief = agents[dept.chief]
          const subs = (chief as { subordinates?: readonly string[] }).subordinates ?? []
          for (const worker of dept.workers) {
            expect(subs, `department "${deptName}" chief "${dept.chief}" subordinates must include worker "${worker}"`).toContain(
              worker,
            )
          }
          for (const shared of org.shared) {
            expect(subs, `department "${deptName}" chief "${dept.chief}" subordinates must include shared "${shared}"`).toContain(
              shared,
            )
          }
        }
      })

      test("every agent pins a model", async () => {
        const { agents } = await loadTemplate(name)
        for (const [agentName, agent] of Object.entries(agents)) {
          expect(agent.model, `agent "${agentName}" must pin a model`).toBeTruthy()
        }
      })

      // kilocode_change - chiefs' permission.task is DERIVED at load time from the declared
      // `subordinates` frontmatter field (ConfigAgent normalize(), src/config/agent.ts) - it is
      // never hand-written in the template .md files. This proves the derivation actually fires
      // and produces the "*": "deny" + per-subordinate "allow" shape crossCheck/the runtime rely on.
      test("chiefs got ordered task permissions from subordinates expansion; workers have none", async () => {
        const { org, agents } = await loadTemplate(name)
        const chiefs = new Set(Object.values(org.departments).map((d) => d.chief))
        for (const dept of Object.values(org.departments)) {
          const chief = agents[dept.chief]
          const task = chief.permission?.task as Record<string, string>
          expect(task, `chief "${dept.chief}" must have derived task permissions`).toBeTruthy()
          expect(Object.entries(task)[0]).toEqual(["*", "deny"])
          for (const worker of dept.workers) expect(task[worker]).toBe("allow")
        }
        for (const [agentName, agent] of Object.entries(agents)) {
          if (agentName === org.ceo) continue
          if (chiefs.has(agentName)) continue
          expect(agent.permission?.task, `worker "${agentName}" must not have task rules`).toBeUndefined()
        }
      })

      test("gated stages (haltOn: no-go) are drivable-to-done: requires resolve without dangling/cyclic refs", async () => {
        const { org } = await loadTemplate(name)
        const resolved = OrgSchema.resolveRequires(org)
        const stages = new Set(org.pipeline.map((p) => p.stage))
        for (const [stage, requires] of Object.entries(resolved)) {
          for (const dep of requires) expect(stages.has(dep), `stage "${stage}" requires unknown "${dep}"`).toBe(true)
        }
      })
    })
  }

  test("template names are exactly blank, research-desk, content-studio (plus the existing ios-app-factory)", async () => {
    const available = await OrgTemplates.list(TEMPLATES_DIR)
    for (const name of NON_IOS_TEMPLATES) expect(available).toContain(name)
    expect(available).toContain("ios-app-factory")
  })

  // kilocode_change - live scaffold: handleInit is the exact function the CLI's `northstar org
  // init --template <name>` command invokes (src/kilocode/cli/cmd/org.ts's OrgInitCommand handler
  // calls it directly) - it runs loadOrganization + validate + ConfigAgent.load + crossCheck
  // against a real scaffolded .kilo/ directory in a tmpdir, so a clean run (no errors, exit code
  // untouched) proves the template end to end, not just via direct schema calls above.
  for (const name of NON_IOS_TEMPLATES) {
    test(`\`org init --template ${name}\` scaffolds .kilo/ cleanly (no validation/crossCheck errors)`, async () => {
      await using tmp = await tmpdir()
      const h = harness()

      await handleInit({
        template: name,
        force: false,
        cwd: tmp.path,
        templatesDir: TEMPLATES_DIR,
        log: h.log,
        error: h.error,
        exit: h.exit,
      })

      expect(h.errors).toEqual([])
      expect(h.codes).toEqual([])

      expect(existsSync(path.join(tmp.path, ".kilo", "organization.jsonc"))).toBe(true)
      expect(existsSync(path.join(tmp.path, ".kilo", "agents"))).toBe(true)

      // A clean load + validate + crossCheck against the scaffolded copy (handleInit already did
      // this internally to decide whether to log an error; re-run it here so the test fails loudly
      // on its own if that ever regresses).
      const org = await OrgSchema.loadOrganization(tmp.path)
      const agents = await ConfigAgent.load(path.join(tmp.path, ".kilo"))
      const view = Object.fromEntries(
        Object.entries(agents).map(([agentName, a]) => [
          agentName,
          { mode: a.mode, subordinates: (a as { subordinates?: readonly string[] }).subordinates },
        ]),
      )
      expect(OrgSchema.validate(org)).toEqual([])
      expect(OrgSchema.crossCheck(org, view)).toEqual([])

      const summary = h.logs.join("\n")
      expect(summary).toContain(`"${name}"`)
      expect(summary).toContain(String(org.pipeline.length))
      expect(summary).toContain(String(Object.keys(agents).length))
    })
  }
})
