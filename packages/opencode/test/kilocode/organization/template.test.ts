// packages/opencode/test/kilocode/organization/template.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { parse as parseJsonc } from "jsonc-parser"
import * as ConfigAgent from "../../../src/config/agent"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { tmpdir } from "../../fixture/fixture"

const TEMPLATE = path.resolve(import.meta.dir, "../../../../..", "org-template")

async function loadTemplate() {
  const text = await Bun.file(path.join(TEMPLATE, "organization.jsonc")).text()
  const org = OrgSchema.parse(parseJsonc(text))
  const agents = await ConfigAgent.load(TEMPLATE)
  return { org, agents }
}

describe("org-template consistency", () => {
  test("organization.jsonc is structurally valid", async () => {
    const { org } = await loadTemplate()
    expect(OrgSchema.validate(org)).toEqual([])
    expect(org.pipeline.length).toBe(10)
    expect(org.pipeline[0]).toMatchObject({ stage: "evaluation", gate: "human", haltOn: "no-go" })
    // kilocode_change - W5.4: review is the pre-ship quality gate, inserted between debugging and
    // the terminal marketing stage.
    expect(org.pipeline[7]).toMatchObject({
      stage: "review",
      requires: ["debugging"],
      gate: "human",
      haltOn: "no-go",
    })
    expect(org.pipeline[8]).toMatchObject({ stage: "marketing", requires: ["review"], gate: "human" })
    // kilocode_change - W7.6: delivery is the final ship gate, inserted after marketing (which is
    // no longer terminal). gate:"human" here IS the ship approval; haltOn:"no-go" mirrors every
    // other gated stage.
    expect(org.pipeline[9]).toMatchObject({
      stage: "delivery",
      requires: ["marketing"],
      gate: "human",
      haltOn: "no-go",
    })
  })

  // kilocode_change - wave-close finding #2/#3: marketing must ship unconditionally. It is the
  // terminal App-Store deliverable (ASO/copy/pricing/preview) - gating it behind when:{mode:"full"}
  // silently dropped it on every default (no-mode) run, since org_start's mode defaults to
  // undefined and ceo.md never sets it.
  test("marketing carries no `when` condition (ships unconditionally, not gated behind mode)", async () => {
    const { org } = await loadTemplate()
    const marketing = org.pipeline.find((p) => p.stage === "marketing")
    expect(marketing?.when).toBeUndefined()
  })

  test("all 63 agent files load and cross-check against the org chart", async () => {
    const { org, agents } = await loadTemplate()
    expect(Object.keys(agents).length).toBe(63)
    const view = Object.fromEntries(
      Object.entries(agents).map(([name, a]) => [
        name,
        { mode: a.mode, subordinates: (a as { subordinates?: readonly string[] }).subordinates },
      ]),
    )
    expect(OrgSchema.crossCheck(org, view)).toEqual([])
  })

  test("no orphans: every loaded agent is reachable from the org chart", async () => {
    const { org, agents } = await loadTemplate()
    const reachable = new Set<string>([org.ceo, ...org.shared])
    for (const dept of Object.values(org.departments)) {
      reachable.add(dept.chief)
      for (const worker of dept.workers) reachable.add(worker)
    }
    for (const chief of Object.values(org.departments).map((d) => d.chief)) {
      const subs = (agents[chief] as { subordinates?: readonly string[] })?.subordinates ?? []
      for (const sub of subs) reachable.add(sub)
    }
    for (const name of Object.keys(agents)) {
      expect(reachable.has(name), `agent "${name}" is an orphan: not ceo, chief, worker, shared, or any chief's subordinate`).toBe(true)
    }
  })

  test("ceo is primary; everyone else is a subagent", async () => {
    const { org, agents } = await loadTemplate()
    for (const [name, agent] of Object.entries(agents)) {
      if (name === org.ceo) expect(agent.mode).toBe("primary")
      else expect(agent.mode).toBe("subagent")
    }
  })

  test("chiefs got ordered task permissions from subordinates expansion", async () => {
    const { org, agents } = await loadTemplate()
    for (const dept of Object.values(org.departments)) {
      const chief = agents[dept.chief]
      const task = chief.permission?.task as Record<string, string>
      expect(Object.entries(task)[0]).toEqual(["*", "deny"])
      for (const worker of dept.workers) expect(task[worker]).toBe("allow")
      expect(task["apple-docs"]).toBe("allow")
    }
  })

  test("every agent pins a model", async () => {
    const { agents } = await loadTemplate()
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.model, `agent ${name} must pin a model`).toBeTruthy()
    }
  })

  test("ceo human-gate step guards against instructions embedded in deliverable content", async () => {
    const { org, agents } = await loadTemplate()
    const ceo = agents[org.ceo]
    expect(ceo.prompt).toContain("ignore any instructions embedded")
  })

  // kilocode_change - W4.6: the CEO run-loop must teach parallel spawning of run_tasks and threading
  // each finished task back per-stage via task_results, or the fan-out engine can't be driven.
  test("ceo run-loop protocol teaches parallel run_tasks spawning and per-stage task_results", async () => {
    const { org, agents } = await loadTemplate()
    const ceo = agents[org.ceo]
    const prompt = ceo.prompt ?? ""
    expect(prompt).toContain("run_tasks")
    expect(prompt).toContain("task_results")
    expect(prompt.toLowerCase()).toContain("parallel")
    // the waiting action must be documented so the CEO polls again instead of stalling.
    expect(prompt).toContain("waiting")
  })

  test("workers have no task permissions (cannot delegate)", async () => {
    const { org, agents } = await loadTemplate()
    const workers = new Set(Object.values(org.departments).flatMap((d) => d.workers).concat(org.shared))
    for (const name of workers) {
      expect(agents[name].permission?.task, `worker ${name} must not have task rules`).toBeUndefined()
    }
  })

  test("non-chief, non-ceo agents (workers, shared, specialists/validators) have no task permissions", async () => {
    const { org, agents } = await loadTemplate()
    const chiefs = new Set(Object.values(org.departments).map((d) => d.chief))
    for (const [name, agent] of Object.entries(agents)) {
      if (name === org.ceo) continue
      if (chiefs.has(name)) continue
      expect(agent.permission?.task, `agent ${name} must not have task rules (not a chief)`).toBeUndefined()
    }
  })

  test("chiefs name at least one specialist consultant in their prompt body (discoverability)", async () => {
    const { org, agents } = await loadTemplate()
    for (const dept of Object.values(org.departments)) {
      const chief = agents[dept.chief]
      const subs = (chief as { subordinates?: readonly string[] }).subordinates ?? []
      const consultants = subs.filter((s) => !dept.workers.includes(s) && !org.shared.includes(s))
      expect(consultants.length, `chief ${dept.chief} must have consultants beyond workers/shared`).toBeGreaterThan(0)
      const prompt = chief.prompt ?? ""
      expect(
        consultants.some((c) => prompt.includes(c)),
        `chief ${dept.chief} prompt must mention at least one consultant by name (${consultants.join(", ")})`,
      ).toBe(true)
    }
  })

  test("chief edit permission actually allows deliverable writes (relative path, real evaluator)", async () => {
    const { org, agents } = await loadTemplate()
    const { Permission } = await import("../../../src/permission")
    for (const dept of Object.values(org.departments)) {
      const chief = agents[dept.chief]
      const ruleset = Permission.fromConfig(chief.permission ?? {})
      const rel = ".kilo/org/runs/20260710-120000-idea/deliverables/evaluation.md"
      expect(
        Permission.evaluate("edit", rel, ruleset).action,
        `chief ${dept.chief} must be able to write deliverables`,
      ).toBe("allow")
      expect(Permission.evaluate("edit", "Sources/App/Main.swift", ruleset).action).toBe("deny")
    }
  })

  test("chief edit permission denies state.json and approvals.json (server-written pipeline state, real evaluator)", async () => {
    const { org, agents } = await loadTemplate()
    const { Permission } = await import("../../../src/permission")
    for (const dept of Object.values(org.departments)) {
      const chief = agents[dept.chief]
      const ruleset = Permission.fromConfig(chief.permission ?? {})
      expect(
        Permission.evaluate("edit", ".kilo/org/runs/x/state.json", ruleset).action,
        `chief ${dept.chief} must not be able to write state.json`,
      ).toBe("deny")
      expect(
        Permission.evaluate("edit", ".kilo/org/runs/x/approvals.json", ruleset).action,
        `chief ${dept.chief} must not be able to write approvals.json`,
      ).toBe("deny")
    }
  })

  // kilocode_change start - W1.0: edit-capable workers deny .kilo/org paths but keep source allow
  const EDIT_CAPABLE_WORKERS = [
    "data-layer-dev",
    "swiftui-dev-1",
    "swiftui-dev-2",
    "unit-tester",
    "ui-tester",
    "debugger",
  ]

  test("edit-capable workers deny .kilo/org paths (real evaluator) while keeping source edit allow", async () => {
    const { agents } = await loadTemplate()
    const { Permission } = await import("../../../src/permission")
    for (const name of EDIT_CAPABLE_WORKERS) {
      const worker = agents[name]
      expect(worker, `worker ${name} must exist in the template`).toBeTruthy()
      const ruleset = Permission.fromConfig(worker.permission ?? {})

      expect(
        Permission.evaluate("edit", "Sources/App/Model.swift", ruleset).action,
        `worker ${name} must keep source edit allow`,
      ).toBe("allow")

      expect(
        Permission.evaluate("edit", ".kilo/org/runs/x/state.json", ruleset).action,
        `worker ${name} must not be able to write .kilo/org/state.json`,
      ).toBe("deny")
      expect(
        Permission.evaluate("edit", ".kilo/org/runs/x/approvals.json", ruleset).action,
        `worker ${name} must not be able to write .kilo/org/approvals.json`,
      ).toBe("deny")
      expect(
        Permission.evaluate("edit", "nested/dir/.kilo/org/runs/x/state.json", ruleset).action,
        `worker ${name} must not be able to write nested .kilo/org paths`,
      ).toBe("deny")
    }
  })
  // kilocode_change end

  // kilocode_change start - W2.6: xcode_build/xcode_test/crash_symbolicate pre-grants
  const BUILD_TOOL_GRANTS: Record<string, ("xcode_build" | "xcode_test" | "crash_symbolicate")[]> = {
    "swiftui-dev-1": ["xcode_build"],
    "swiftui-dev-2": ["xcode_build"],
    "data-layer-dev": ["xcode_build"],
    "unit-tester": ["xcode_build", "xcode_test"],
    "ui-tester": ["xcode_build", "xcode_test"],
    debugger: ["xcode_build", "xcode_test", "crash_symbolicate"],
  }
  const BUILD_TOOL_KEYS = ["xcode_build", "xcode_test", "crash_symbolicate"] as const

  test("dev/test/debug workers hold exactly their granted xcode_build/xcode_test/crash_symbolicate keys (real evaluator)", async () => {
    const { agents } = await loadTemplate()
    const { Permission } = await import("../../../src/permission")
    for (const [name, granted] of Object.entries(BUILD_TOOL_GRANTS)) {
      const worker = agents[name]
      expect(worker, `worker ${name} must exist in the template`).toBeTruthy()
      const ruleset = Permission.fromConfig(worker.permission ?? {})
      for (const key of BUILD_TOOL_KEYS) {
        const expected = granted.includes(key) ? "allow" : "ask"
        expect(
          Permission.evaluate(key, "*", ruleset).action,
          `worker ${name} permission "${key}" expected ${expected}`,
        ).toBe(expected)
      }
    }
  })

  test("consultants/chiefs/CEO do not hold xcode_build/xcode_test/crash_symbolicate grants (default ask, real evaluator)", async () => {
    const { org, agents } = await loadTemplate()
    const { Permission } = await import("../../../src/permission")
    const granted = new Set(Object.keys(BUILD_TOOL_GRANTS))
    for (const [name, agent] of Object.entries(agents)) {
      if (granted.has(name)) continue
      const ruleset = Permission.fromConfig(agent.permission ?? {})
      for (const key of BUILD_TOOL_KEYS) {
        expect(
          Permission.evaluate(key, "*", ruleset).action,
          `agent ${name} must not hold "${key}" (not a dev/test/debug worker)`,
        ).not.toBe("allow")
      }
    }
    // Sanity: the grant map itself only names actual dev/test/debug workers, not chiefs/CEO/consultants.
    const chiefs = new Set(Object.values(org.departments).map((d) => d.chief))
    for (const name of granted) {
      expect(chiefs.has(name), `${name} in BUILD_TOOL_GRANTS must not be a chief`).toBe(false)
      expect(name === org.ceo, `${name} in BUILD_TOOL_GRANTS must not be the CEO`).toBe(false)
    }
  })

  test("roster stays green: 63 agents after the W5.3/W5.4 review + W7.6 delivery department additions", async () => {
    const { agents } = await loadTemplate()
    expect(Object.keys(agents).length).toBe(63)
  })
  // kilocode_change end

  // kilocode_change start - W5.3/W5.4: review department (pre-ship quality gate)
  describe("W5.4 review department + stage", () => {
    test("review department exists with review-chief and the 3 designated workers", async () => {
      const { org } = await loadTemplate()
      expect(org.departments["review"]).toEqual({
        chief: "review-chief",
        workers: ["security-validator", "senior-engineer-reviewer", "privacy-manifest-validator"],
      })
    })

    test("review-chief's subordinates cover its workers + shared + consultant validators", async () => {
      const { org, agents } = await loadTemplate()
      const reviewChief = agents["review-chief"]
      const subs = (reviewChief as { subordinates?: readonly string[] }).subordinates ?? []
      for (const worker of org.departments["review"].workers) expect(subs).toContain(worker)
      for (const shared of org.shared) expect(subs).toContain(shared)
      // consultants beyond workers/shared: reuses validators that are already other chiefs' workers/consultants.
      const consultants = ["appstore-review-validator", "accessibility-validator", "hig-validator", "entitlement-validator"]
      for (const consultant of consultants) expect(subs).toContain(consultant)
    })

    test("review-chief prompt names its reviewers (consensus convention)", async () => {
      const { agents } = await loadTemplate()
      const prompt = agents["review-chief"].prompt ?? ""
      for (const name of [
        "security-validator",
        "privacy-manifest-validator",
        "appstore-review-validator",
        "senior-engineer-reviewer",
      ]) {
        expect(prompt.includes(name), `review-chief prompt must mention "${name}"`).toBe(true)
      }
      expect(prompt.toLowerCase()).toContain("parallel")
      expect(prompt).toContain("PASS")
      expect(prompt).toContain("BLOCK")
    })

    test("review-chief edit permission is deliverables-scoped, not source/state (real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      const ruleset = Permission.fromConfig(agents["review-chief"].permission ?? {})
      const rel = ".kilo/org/runs/20260710-120000-idea/deliverables/review.md"
      expect(Permission.evaluate("edit", rel, ruleset).action).toBe("allow")
      expect(Permission.evaluate("edit", "Sources/App/Main.swift", ruleset).action).toBe("deny")
      expect(Permission.evaluate("edit", ".kilo/org/runs/x/state.json", ruleset).action).toBe("deny")
      expect(Permission.evaluate("edit", ".kilo/org/runs/x/approvals.json", ruleset).action).toBe("deny")
    })

    test("review-chief task grants include its workers + apple-docs (ordered, real evaluator)", async () => {
      const { org, agents } = await loadTemplate()
      const chief = agents["review-chief"]
      const task = chief.permission?.task as Record<string, string>
      expect(Object.entries(task)[0]).toEqual(["*", "deny"])
      for (const worker of org.departments["review"].workers) expect(task[worker]).toBe("allow")
      expect(task["apple-docs"]).toBe("allow")
    })

    // kilocode_change - compliance-tool grants (W5.1/W5.2 tools -> W5.3 reviewers), mirrors the
    // BUILD_TOOL_GRANTS style above but for the compliance tools rather than the xcode tools.
    const COMPLIANCE_TOOL_GRANTS: Record<string, ("privacy_manifest_check" | "secret_scan" | "ats_check")[]> = {
      "privacy-manifest-validator": ["privacy_manifest_check"],
      "appstore-review-validator": ["secret_scan", "ats_check"],
      "security-validator": ["secret_scan", "ats_check"],
    }
    const COMPLIANCE_TOOL_KEYS = ["privacy_manifest_check", "secret_scan", "ats_check"] as const

    test("reviewers hold exactly their granted compliance-tool keys (real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      for (const [name, granted] of Object.entries(COMPLIANCE_TOOL_GRANTS)) {
        const agent = agents[name]
        expect(agent, `agent ${name} must exist in the template`).toBeTruthy()
        const ruleset = Permission.fromConfig(agent.permission ?? {})
        for (const key of COMPLIANCE_TOOL_KEYS) {
          const expected = granted.includes(key) ? "allow" : "ask"
          expect(
            Permission.evaluate(key, "*", ruleset).action,
            `agent ${name} permission "${key}" expected ${expected}`,
          ).toBe(expected)
        }
      }
    })

    test("non-reviewers do not hold compliance-tool grants (default ask, real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      const granted = new Set(Object.keys(COMPLIANCE_TOOL_GRANTS))
      for (const [name, agent] of Object.entries(agents)) {
        if (granted.has(name)) continue
        const ruleset = Permission.fromConfig(agent.permission ?? {})
        for (const key of COMPLIANCE_TOOL_KEYS) {
          expect(
            Permission.evaluate(key, "*", ruleset).action,
            `agent ${name} must not hold "${key}" (not a granted reviewer)`,
          ).not.toBe("allow")
        }
      }
    })

    test("security-validator and senior-engineer-reviewer are subagent workers with no subordinates", async () => {
      const { agents } = await loadTemplate()
      for (const name of ["security-validator", "senior-engineer-reviewer"]) {
        const agent = agents[name]
        expect(agent.mode).toBe("subagent")
        expect((agent as { subordinates?: readonly string[] }).subordinates ?? []).toEqual([])
        expect(agent.permission?.task).toBeUndefined()
      }
    })
  })
  // kilocode_change end

  // kilocode_change start - W4.7: the shipped template now exercises the DAG engine itself -
  // a diamond (backend/frontend both require ux, testing joins them) plus an mvp-skip on
  // marketing. These tests would fail (RED) against the pre-W4.7 fully-linear template: resolveRequires
  // would map backend/frontend to their own previous pipeline entries (not both to "ux"), readyStages
  // after "ux" completes would be a single stage (not the pair), and maxConcurrency would be undefined.
  describe("W4.7 DAG template: frontend/backend diamond + marketing mvp-skip", () => {
    test("resolveRequires: backend and frontend both require ux; testing joins them; every other stage requires exactly its previous pipeline entry", async () => {
      const { org } = await loadTemplate()
      const resolved = OrgSchema.resolveRequires(org)

      // the diamond
      expect(resolved["backend"]).toEqual(["ux"])
      expect(resolved["frontend"]).toEqual(["ux"])
      expect(resolved["testing"]).toEqual(["backend", "frontend"])

      // everything else stays the default linear chain (explicit spot-checks)
      expect(resolved["evaluation"]).toEqual([])
      expect(resolved["planning"]).toEqual(["evaluation"])
      expect(resolved["ux"]).toEqual(["planning"])
      expect(resolved["debugging"]).toEqual(["testing"])
      // kilocode_change - W5.4: review sits between debugging and marketing (both explicit
      // `requires`, not the default previous-stage chain).
      expect(resolved["review"]).toEqual(["debugging"])
      expect(resolved["marketing"]).toEqual(["review"])
      // kilocode_change - W7.6: delivery sits after marketing (explicit `requires`), the new
      // terminal stage.
      expect(resolved["delivery"]).toEqual(["marketing"])

      // full pipeline order sanity - unchanged by the DAG edit except the W5.4 review insertion
      // and the W7.6 delivery insertion
      expect(org.pipeline.map((p) => p.stage)).toEqual([
        "evaluation",
        "planning",
        "ux",
        "backend",
        "frontend",
        "testing",
        "debugging",
        "review",
        "marketing",
        "delivery",
      ])
    })

    test("org.maxConcurrency is 2 (lets backend/frontend actually run concurrently)", async () => {
      const { org } = await loadTemplate()
      expect(org.maxConcurrency).toBe(2)
    })

    test("marketing is unconditional (no `when`) but NO LONGER terminal now that delivery requires it; delivery is the new terminal stage", async () => {
      const { org } = await loadTemplate()
      const marketing = org.pipeline.find((p) => p.stage === "marketing")
      expect(marketing?.when).toBeUndefined()
      const delivery = org.pipeline.find((p) => p.stage === "delivery")
      expect(delivery?.when).toBeUndefined()

      const resolved = OrgSchema.resolveRequires(org)
      // kilocode_change - W7.6: marketing is no longer terminal - delivery is its one dependent.
      expect(resolved["delivery"]).toEqual(["marketing"])
      // terminal: nothing in the pipeline requires delivery, so it can't strand a dependent.
      for (const [stage, requires] of Object.entries(resolved)) {
        expect(requires.includes("delivery"), `stage "${stage}" must not require delivery`).toBe(false)
      }
    })

    test("readyStages after ux completes = [backend, frontend], in pipeline order (proves the diamond, not the linear default)", async () => {
      const { org } = await loadTemplate()
      const priorStages = new Set(["evaluation", "planning", "ux"])
      const run = OrgState.Run.parse({
        runID: "r1",
        idea: "test idea",
        createdAt: new Date().toISOString(),
        status: "active",
        stages: Object.fromEntries(
          org.pipeline.map((p) => [p.stage, { status: priorStages.has(p.stage) ? "completed" : "pending", attempts: 0 }]),
        ),
      })
      // Against a still-linear pipeline this would resolve to just ["backend"] (backend's default
      // requires would be [ux], but frontend's default requires would be [backend], not [ux]) -
      // this assertion is the RED/GREEN pivot for the W4.7 edit.
      expect(OrgState.readyStages(org, run)).toEqual(["backend", "frontend"])
    })

    test("readyStages after ux+backend+frontend all complete = [testing] (the join), not before", async () => {
      const { org } = await loadTemplate()
      const statuses: Record<string, OrgState.StageStatus> = {
        evaluation: "completed",
        planning: "completed",
        ux: "completed",
        backend: "completed",
        frontend: "running",
        testing: "pending",
        debugging: "pending",
        marketing: "pending",
      }
      const notJoinedYet = OrgState.Run.parse({
        runID: "r2",
        idea: "test idea",
        createdAt: new Date().toISOString(),
        status: "active",
        stages: Object.fromEntries(Object.entries(statuses).map(([s, status]) => [s, { status, attempts: 0 }])),
      })
      expect(OrgState.readyStages(org, notJoinedYet)).toEqual([])

      const joined = OrgState.Run.parse({
        ...notJoinedYet,
        stages: { ...notJoinedYet.stages, frontend: { status: "completed", attempts: 0 } },
      })
      expect(OrgState.readyStages(org, joined)).toEqual(["testing"])
    })

    // kilocode_change - wave-close finding #2/#3 regression test: a PLAIN run with no mode set
    // (org_start's mode defaults to undefined; ceo.md never sets it - this is what every default
    // run looks like) must still drive marketing to completion. Before the fix, marketing carried
    // when:{mode:"full"}, so this exact scenario silently skipped it and the org's whole reason
    // for existing (the App-Store package) was never produced. This test is RED against the
    // pre-fix template (marketing would resolve to "skipped", not "completed") and GREEN once the
    // `when` is removed from the shipped marketing stage.
    test("live run via OrgRunner: a run with NO mode set drives marketing then delivery to completion (not skipped)", async () => {
      await using tmp = await tmpdir()
      const { org } = await loadTemplate()
      const deps = { costOf: async () => 0.1 }

      async function writeDeliverable(runID: string, stage: string) {
        const file = OrgArtifacts.deliverablePath(tmp.path, runID, stage)
        await mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
      }

      const run = await OrgRunner.start(tmp.path, org, "no mode idea")
      expect(run.mode).toBeUndefined()

      // Drive: evaluation (gate:human) -> approve -> planning -> ux -> backend+frontend (parallel,
      // maxConcurrency 2) -> testing -> debugging -> marketing (gate:human) -> approve -> done.
      await OrgRunner.advance(deps, tmp.path, org, run.runID, {})
      await writeDeliverable(run.runID, "evaluation")
      await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_eval" })
      await OrgRunner.decide(tmp.path, org, run.runID, "approve")

      await OrgRunner.advance(deps, tmp.path, org, run.runID, {}) // instructs planning
      await writeDeliverable(run.runID, "planning")
      await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_plan" }) // instructs ux
      await writeDeliverable(run.runID, "ux")
      const afterUx = await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_ux" })
      expect(afterUx.instruct.map((i) => i.stage).sort()).toEqual(["backend", "frontend"])

      await writeDeliverable(run.runID, "backend")
      await writeDeliverable(run.runID, "frontend")
      const afterDiamond = await OrgRunner.advance(deps, tmp.path, org, run.runID, {
        taskResults: [
          { stage: "backend", taskID: "ses_backend" },
          { stage: "frontend", taskID: "ses_frontend" },
        ],
      })
      expect(afterDiamond.instruct.map((i) => i.stage)).toEqual(["testing"])

      await writeDeliverable(run.runID, "testing")
      await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_testing" }) // instructs debugging
      await writeDeliverable(run.runID, "debugging")
      const afterDebugging = await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_debugging" })

      // kilocode_change - W5.4: debugging now feeds the review gate, not marketing directly.
      expect(afterDebugging.instruct.map((i) => i.stage)).toEqual(["review"])
      await writeDeliverable(run.runID, "review")
      const afterReview = await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_review" })
      expect(afterReview.gate).toBeDefined() // review has gate:"human"
      expect(afterReview.gate!.stage).toBe("review")
      await OrgRunner.decide(tmp.path, org, run.runID, "approve")

      // marketing must now be INSTRUCTED (its when:{mode:"full"} is gone, and review passed).
      const afterDebugging2 = await OrgRunner.advance(deps, tmp.path, org, run.runID, {})
      expect(afterDebugging2.instruct.map((i) => i.stage)).toEqual(["marketing"])
      const midState = await OrgState.read(tmp.path, run.runID)
      expect(midState.stages["marketing"].status).toBe("running")

      await writeDeliverable(run.runID, "marketing")
      const afterMarketing = await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_marketing" })
      expect(afterMarketing.gate).toBeDefined() // marketing has gate:"human"
      expect(afterMarketing.gate!.stage).toBe("marketing")
      await OrgRunner.decide(tmp.path, org, run.runID, "approve")

      // kilocode_change start - W7.6: marketing's approval now instructs "delivery" (the final
      // ship gate) instead of completing the run directly.
      const afterMarketingApprove = await OrgRunner.advance(deps, tmp.path, org, run.runID, {})
      expect(afterMarketingApprove.instruct.map((i) => i.stage)).toEqual(["delivery"])
      const midStateDelivery = await OrgState.read(tmp.path, run.runID)
      expect(midStateDelivery.stages["delivery"].status).toBe("running")

      await writeDeliverable(run.runID, "delivery")
      const afterDelivery = await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_delivery" })
      expect(afterDelivery.gate).toBeDefined() // delivery has gate:"human" (the ship approval)
      expect(afterDelivery.gate!.stage).toBe("delivery")
      await OrgRunner.decide(tmp.path, org, run.runID, "approve")
      const afterApprove = await OrgRunner.advance(deps, tmp.path, org, run.runID, {})
      expect(afterApprove.done).toBe(true)

      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["marketing"].status).toBe("completed")
      expect(state.stages["delivery"].status).toBe("completed")
      expect(state.status).toBe("completed")
      // kilocode_change end
    })

    // kilocode_change - a `when`-skip demonstration lives on a SYNTHETIC org, not the shipped
    // template: the shipped template no longer gates any stage on mode, so this exercises the
    // `when` feature itself (still fully implemented) without resurrecting the marketing footgun.
    test("live run via OrgRunner (synthetic org): an OPTIONAL stage gated on when:{mode:\"deep\"} is skipped by a normal run", async () => {
      await using tmp = await tmpdir()
      const org = OrgSchema.parse({
        ceo: "ceo",
        departments: {
          a: { chief: "a-chief", workers: ["a-worker"] },
          extra: { chief: "extra-chief", workers: ["extra-worker"] },
        },
        pipeline: [{ stage: "a" }, { stage: "extra", when: { mode: "deep" } }],
      })
      const deps = { costOf: async () => 0.1 }

      async function writeDeliverable(runID: string, stage: string) {
        const file = OrgArtifacts.deliverablePath(tmp.path, runID, stage)
        await mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
      }

      const run = await OrgRunner.start(tmp.path, org, "normal run, no mode")
      await OrgRunner.advance(deps, tmp.path, org, run.runID, {}) // instructs "a"
      await writeDeliverable(run.runID, "a")
      const after = await OrgRunner.advance(deps, tmp.path, org, run.runID, { taskID: "ses_a" })

      expect(after.instruct.some((i) => i.stage === "extra")).toBe(false)
      expect(after.done).toBe(true)
      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["extra"].status).toBe("skipped")
    })
  })
  // kilocode_change end

  // kilocode_change start - W7.6: delivery department + stage (final ship gate)
  describe("W7.6 delivery department + stage", () => {
    test("delivery department exists with delivery-chief and the release-engineer worker", async () => {
      const { org } = await loadTemplate()
      expect(org.departments["delivery"]).toEqual({
        chief: "delivery-chief",
        workers: ["release-engineer"],
      })
    })

    test("delivery-chief's subordinates cover its worker + shared + the appstore-review-validator consultant", async () => {
      const { org, agents } = await loadTemplate()
      const deliveryChief = agents["delivery-chief"]
      const subs = (deliveryChief as { subordinates?: readonly string[] }).subordinates ?? []
      for (const worker of org.departments["delivery"].workers) expect(subs).toContain(worker)
      for (const shared of org.shared) expect(subs).toContain(shared)
      expect(subs).toContain("appstore-review-validator")
    })

    test("delivery-chief edit permission is deliverables-scoped, not source/state (real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      const ruleset = Permission.fromConfig(agents["delivery-chief"].permission ?? {})
      const rel = ".kilo/org/runs/20260710-120000-idea/deliverables/delivery.md"
      expect(Permission.evaluate("edit", rel, ruleset).action).toBe("allow")
      expect(Permission.evaluate("edit", "Sources/App/Main.swift", ruleset).action).toBe("deny")
      expect(Permission.evaluate("edit", ".kilo/org/runs/x/state.json", ruleset).action).toBe("deny")
      expect(Permission.evaluate("edit", ".kilo/org/runs/x/approvals.json", ruleset).action).toBe("deny")
    })

    test("release-engineer keeps source edit allow but denies .kilo/org paths (real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      const ruleset = Permission.fromConfig(agents["release-engineer"].permission ?? {})
      expect(Permission.evaluate("edit", "Sources/App/Main.swift", ruleset).action).toBe("allow")
      expect(Permission.evaluate("edit", ".kilo/org/runs/x/state.json", ruleset).action).toBe("deny")
      expect(Permission.evaluate("edit", ".kilo/org/runs/x/approvals.json", ruleset).action).toBe("deny")
    })

    test("release-engineer is a subagent worker with no subordinates (cannot delegate)", async () => {
      const { agents } = await loadTemplate()
      const worker = agents["release-engineer"]
      expect(worker.mode).toBe("subagent")
      expect((worker as { subordinates?: readonly string[] }).subordinates ?? []).toEqual([])
      expect(worker.permission?.task).toBeUndefined()
    })

    // kilocode_change - ASC/xcode delivery-tool grants (W7.1/W7.4/W7.6 tools -> the delivery dept),
    // mirrors BUILD_TOOL_GRANTS/COMPLIANCE_TOOL_GRANTS above but for the ship-flow tools. Chief and
    // worker hold DIFFERENT subsets: release-engineer does the archive/export/validate mechanics,
    // delivery-chief holds only the two agent-facing "act on the ship gate" tools (asc_submit,
    // asc_status) it calls itself once the human gate approves.
    const DELIVERY_TOOL_GRANTS: Record<
      string,
      ("xcode_archive" | "ipa_export" | "asc_metadata_validate" | "asc_submit" | "asc_status")[]
    > = {
      "release-engineer": ["xcode_archive", "ipa_export", "asc_metadata_validate", "asc_submit", "asc_status"],
      "delivery-chief": ["asc_submit", "asc_status"],
    }
    const DELIVERY_TOOL_KEYS = [
      "xcode_archive",
      "ipa_export",
      "asc_metadata_validate",
      "asc_submit",
      "asc_status",
    ] as const

    test("delivery agents hold exactly their granted ASC/xcode delivery-tool keys (real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      for (const [name, granted] of Object.entries(DELIVERY_TOOL_GRANTS)) {
        const agent = agents[name]
        expect(agent, `agent ${name} must exist in the template`).toBeTruthy()
        const ruleset = Permission.fromConfig(agent.permission ?? {})
        for (const key of DELIVERY_TOOL_KEYS) {
          const expected = granted.includes(key) ? "allow" : "ask"
          expect(
            Permission.evaluate(key, "*", ruleset).action,
            `agent ${name} permission "${key}" expected ${expected}`,
          ).toBe(expected)
        }
      }
    })

    // xcode_archive/ipa_export/asc_submit/asc_status are net-new in W7.6 - nobody else in the
    // template holds them yet, so a blanket "not granted" sweep is safe for those four keys.
    // asc_metadata_validate predates this wave (marketing-chief, appstore-review-validator already
    // hold it - W7.4) so it is deliberately excluded from this negative sweep.
    test("agents outside the delivery grant map do not hold xcode_archive/ipa_export/asc_submit/asc_status (default ask, real evaluator)", async () => {
      const { agents } = await loadTemplate()
      const { Permission } = await import("../../../src/permission")
      const granted = new Set(Object.keys(DELIVERY_TOOL_GRANTS))
      const swept = ["xcode_archive", "ipa_export", "asc_submit", "asc_status"] as const
      for (const [name, agent] of Object.entries(agents)) {
        if (granted.has(name)) continue
        const ruleset = Permission.fromConfig(agent.permission ?? {})
        for (const key of swept) {
          expect(
            Permission.evaluate(key, "*", ruleset).action,
            `agent ${name} must not hold "${key}" (not a granted delivery agent)`,
          ).not.toBe("allow")
        }
      }
    })

    // kilocode_change - runner-drive coverage (mirrors wave6-exit.test.ts's GATED-org shape): the
    // delivery stage's gate is exercised directly via OrgRunner on a small synthetic org, proving
    // the gate/haltOn wiring independent of the full 10-stage shipped template.
    const DELIVERY_GATE_ORG = OrgSchema.parse({
      ceo: "ceo",
      departments: {
        marketing: { chief: "mkt-chief", workers: ["copywriter"] },
        delivery: { chief: "delivery-chief", workers: ["release-engineer"] },
      },
      pipeline: [
        { stage: "marketing" },
        { stage: "delivery", requires: ["marketing"], gate: "human", haltOn: "no-go" },
      ],
    })

    async function writeSyntheticDeliverable(dir: string, runID: string, stage: string) {
      const file = OrgArtifacts.deliverablePath(dir, runID, stage)
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
    }

    test("delivery stage reaches awaiting_approval (gate) right after marketing completes", async () => {
      await using tmp = await tmpdir()
      const deps = { costOf: async () => 0.1 }
      const run = await OrgRunner.start(tmp.path, DELIVERY_GATE_ORG, "delivery gate idea")

      await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, {}) // instructs marketing
      await writeSyntheticDeliverable(tmp.path, run.runID, "marketing")
      const afterMarketing = await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, {
        taskID: "ses_mkt",
      })
      // marketing has no gate of its own on this synthetic org, so it instructs delivery directly.
      expect(afterMarketing.instruct.map((i) => i.stage)).toEqual(["delivery"])

      await writeSyntheticDeliverable(tmp.path, run.runID, "delivery")
      const afterDelivery = await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, {
        taskID: "ses_delivery",
      })
      expect(afterDelivery.gate).toBeDefined()
      expect(afterDelivery.gate!.stage).toBe("delivery")

      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["delivery"].status).toBe("awaiting_approval")
    })

    test("a no-go decision on the delivery gate halts the run (nothing shipped)", async () => {
      await using tmp = await tmpdir()
      const deps = { costOf: async () => 0.1 }
      const run = await OrgRunner.start(tmp.path, DELIVERY_GATE_ORG, "delivery no-go idea")

      await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, {})
      await writeSyntheticDeliverable(tmp.path, run.runID, "marketing")
      await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, { taskID: "ses_mkt" })
      await writeSyntheticDeliverable(tmp.path, run.runID, "delivery")
      const gated = await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, { taskID: "ses_delivery" })
      expect(gated.gate!.stage).toBe("delivery")

      const decided = await OrgRunner.decide(tmp.path, DELIVERY_GATE_ORG, run.runID, "no-go", "not ready to ship")
      expect(decided.status).toBe("halted")
      expect(decided.haltReason).toContain("not ready to ship")

      // "nothing shipped": the RUN halts (haltReason recorded) - asc_submit is never reachable
      // once the run is halted, since org_advance short-circuits on status "halted" (see
      // OrgRunner.advance's early-exit). The delivery stage record itself is marked "completed"
      // (its gate WAS resolved - just with a no-go) which is the same shape every other
      // haltOn:"no-go" stage in this template already uses (e.g. evaluation, review).
      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.status).toBe("halted")
      expect(state.haltReason).toContain("not ready to ship")
    })

    test("an approve decision on the delivery gate lets the run proceed to done", async () => {
      await using tmp = await tmpdir()
      const deps = { costOf: async () => 0.1 }
      const run = await OrgRunner.start(tmp.path, DELIVERY_GATE_ORG, "delivery approve idea")

      await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, {})
      await writeSyntheticDeliverable(tmp.path, run.runID, "marketing")
      await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, { taskID: "ses_mkt" })
      await writeSyntheticDeliverable(tmp.path, run.runID, "delivery")
      const gated = await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, { taskID: "ses_delivery" })
      expect(gated.gate!.stage).toBe("delivery")

      await OrgRunner.decide(tmp.path, DELIVERY_GATE_ORG, run.runID, "approve")
      const afterApprove = await OrgRunner.advance(deps, tmp.path, DELIVERY_GATE_ORG, run.runID, {})
      expect(afterApprove.done).toBe(true)

      const state = await OrgState.read(tmp.path, run.runID)
      expect(state.stages["delivery"].status).toBe("completed")
      expect(state.status).toBe("completed")
    })
  })
  // kilocode_change end
})
