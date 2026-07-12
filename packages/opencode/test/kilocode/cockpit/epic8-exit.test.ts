// kilocode_change - new file
import path from "path"
import fs from "node:fs"
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import type { OrgRunSummary } from "@kilocode/sdk/v2/client"
import { OrgRunsPaths } from "../../../src/kilocode/server/httpapi/groups/org-runs"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { buildAgentTree, budgetGauge, buildRunList, dryRunReport } from "../../../src/kilocode/cockpit/cockpit-view"
import { stopMessage } from "../../../src/kilocode/cockpit/stop"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

/**
 * EPIC 8 (TUI Cockpit) EXIT TEST (Task 8.4): one end-to-end scenario proving the pieces EPIC 8
 * built work TOGETHER on a real run, not just in their own unit tests:
 *
 *  (a) the budget block on `GET /org-runs/:runID` (8.1a): a run seeded with a KNOWN spend produces
 *      `budget.spent`/`budget.remaining`/`budget.run`/`budget.escalationThreshold` derived from
 *      `OrgSchema.resolveBudget` + `OrgState.runSummary(run).totalCost` -- and flips
 *      `budget.escalated` once the run itself is escalated.
 *  (b) `buildAgentTree` (8.1a): fed the REAL detail response's `stages` + the fixture org, it
 *      reproduces ceo, departments in pipeline order, and each chief's liveness from the stage's
 *      real status.
 *  (c) `budgetGauge` (8.1a): fed the REAL budget block, the fraction/threshold/ceiling math lines
 *      up with the seeded spend.
 *  (d) `buildRunList` (8.3): fed a REAL `GET /org-runs` list response, the run's row carries the
 *      right status badge and flips `awaitingGate` once a stage is `awaiting_approval`.
 *  (e) `stopMessage` (8.2) + `dryRunReport` (8.3): the hard-stop message string, and a dry-run
 *      preflight that is `ok:true` for the valid fixture and `ok:false` (with an issue) for a
 *      deliberately-invalid org.
 *  (f) the read-only guard (structural): the Cockpit's own source files never make a functional
 *      `OrgRunner.stop(`/`OrgRunner.decide(` call -- the stop path is message-only (8.2's doc
 *      comment on `stop.ts`), proven here by scanning the actual `.ts`/`.tsx` files rather than
 *      trusting the comment.
 */

type Json = Record<string, unknown>

function app() {
  const handler = HttpRouter.toWebHandler(
    HttpApiServer.routes.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    { disableLogger: true },
  ).handler

  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return handler(
        input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
        HttpApiServer.context,
      )
    },
  }
}

function rec(input: unknown): Json {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("expected object")
  return input as Json
}

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

const AGENTS: Record<string, { mode?: string; subordinates?: readonly string[] }> = {
  ceo: { mode: "primary", subordinates: ["eval-chief", "planning-chief"] },
  "eval-chief": { mode: "subagent", subordinates: ["market-research"] },
  "planning-chief": { mode: "subagent", subordinates: ["architect"] },
  "market-research": { mode: "subagent" },
  architect: { mode: "subagent" },
}

/** A run with a KNOWN total spend of $12 (default budget: run=50, escalationThreshold=10) --
 * evaluation's gate already cleared (approved), planning currently running. Mirrors
 * `org-runs-budget.test.ts`'s `seedRunWithSpend`. */
async function seedRunWithSpend(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "epic8 exit idea")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["evaluation"].status = "completed"
    s.stages["evaluation"].costs = { ses_a: 8 }
    s.stages["evaluation"].attempts = 1
    s.stages["evaluation"].decision = "approve"
    s.stages["evaluation"].startedAt = "2026-07-11T00:00:00.000Z"
    s.stages["evaluation"].completedAt = "2026-07-11T00:10:00.000Z"
    s.stages["planning"].status = "running"
    s.stages["planning"].costs = { ses_b: 4 }
    s.stages["planning"].attempts = 1
    s.stages["planning"].startedAt = "2026-07-11T00:11:00.000Z"
  })
  return run.runID
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("EPIC 8 exit: budget block + dashboard view-models + read-only stop path", () => {
  test("(a) budget block via GET /org-runs/:runID: spent/remaining/run/escalationThreshold match the seeded spend, escalated flips true once the run is escalated", async () => {
    await using tmp = await tmpdir()
    await OrgSchema.writeOrganization(tmp.path, ORG)
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const budget = rec(body.budget)
    expect(budget.run).toBe(50) // owner-approved default
    expect(budget.escalationThreshold).toBe(10) // owner-approved default
    expect(budget.spent).toBeCloseTo(12, 10) // 8 (evaluation) + 4 (planning)
    expect(budget.remaining).toBeCloseTo((budget.run as number) - (budget.spent as number), 10)
    expect(budget.escalated).toBe(false)

    // Drive the SAME run to escalated and re-fetch through the real endpoint.
    await OrgState.update(tmp.path, runID, (s) => {
      s.escalated = true
    })
    const response2 = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response2.status).toBe(200)
    const body2 = rec(await response2.json())
    expect(rec(body2.budget).escalated).toBe(true)
  })

  test("(b) buildAgentTree fed the real detail response: ceo + departments in pipeline order, chief liveness from the real stage status, static worker roster", async () => {
    await using tmp = await tmpdir()
    await OrgSchema.writeOrganization(tmp.path, ORG)
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const stages = body.stages as { stage: string; status: string }[]

    const tree = buildAgentTree(ORG, { stages })
    expect(tree.ceo).toBe("ceo")
    expect(tree.departments.map((d) => d.stage)).toEqual(["evaluation", "planning"])

    const evaluation = tree.departments[0]
    expect(evaluation.chief).toBe("eval-chief")
    expect(evaluation.status).toBe("completed")
    expect(evaluation.workers).toEqual(["market-research"])

    const planning = tree.departments[1]
    expect(planning.chief).toBe("planning-chief")
    expect(planning.status).toBe("running")
    expect(planning.workers).toEqual(["architect"])
  })

  test("(c) budgetGauge fed the real budget block: fraction/threshold/ceiling math matches the seeded spend", async () => {
    await using tmp = await tmpdir()
    await OrgSchema.writeOrganization(tmp.path, ORG)
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const budget = rec(body.budget) as unknown as {
      run: number
      escalationThreshold: number
      spent: number
      escalated: boolean
    }

    const gauge = budgetGauge(budget)
    expect(gauge.spentFraction).toBeCloseTo(12 / 50, 10)
    expect(gauge.thresholdFraction).toBeCloseTo(10 / 50, 10)
    expect(gauge.overThreshold).toBe(true) // spent(12) >= escalationThreshold(10)
    expect(gauge.overCeiling).toBe(false) // spent(12) < run(50)
    expect(gauge.escalated).toBe(false)
  })

  test("(d) buildRunList fed a real GET /org-runs list response: the run's row carries the right status badge, awaitingGate true once a stage is awaiting_approval", async () => {
    await using tmp = await tmpdir()
    await OrgSchema.writeOrganization(tmp.path, ORG)
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)
    // Move planning into a gate-pending state to exercise the list row's awaitingGate.
    await OrgState.update(tmp.path, runID, (s) => {
      s.stages["planning"].status = "awaiting_approval"
    })

    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const runs = body.runs as OrgRunSummary[]

    const rows = buildRunList(runs)
    const row = rows.find((r) => r.runID === runID)
    expect(row).toBeDefined()
    expect(row!.status).toBe("active")
    expect(row!.badge).toBe("secondary") // runStatusBadge("active")
    expect(row!.awaitingGate).toBe(true)
  })

  test("(e) stopMessage embeds runID + reason; dryRunReport is ok:true for the valid fixture and ok:false (with an issue) for a deliberately-invalid org", () => {
    expect(stopMessage("run-abc-123", "user requested stop")).toBe("stop run run-abc-123: user requested stop")
    expect(stopMessage(undefined, "budget exceeded")).toBe("stop run the current run: budget exceeded")

    const validReport = dryRunReport(ORG, AGENTS)
    expect(validReport).toEqual({
      ok: true,
      departments: 2,
      stages: 2,
      agentCount: 5,
      issues: [],
    })

    // Deliberately invalid: planning-chief's subordinates omit "architect" -- a crossCheck failure.
    const invalidAgents = {
      ...AGENTS,
      "planning-chief": { mode: "subagent", subordinates: [] },
    }
    const invalidReport = dryRunReport(ORG, invalidAgents)
    expect(invalidReport.ok).toBe(false)
    expect(invalidReport.departments).toBe(2)
    expect(invalidReport.stages).toBe(2)
    expect(invalidReport.issues.length).toBeGreaterThan(0)
    expect(invalidReport.issues.some((issue) => issue.includes("architect"))).toBe(true)
  })

  test("(f) read-only cockpit guard: no cockpit source file makes a functional OrgRunner.stop(/OrgRunner.decide( call -- the stop path is message-only", () => {
    const cockpitDir = path.resolve(import.meta.dir, "../../../src/kilocode/cockpit")
    const files = fs.readdirSync(cockpitDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    // Sanity: make sure the scan actually found the module set this test is meant to guard.
    expect(files).toEqual(expect.arrayContaining(["cockpit-view.ts", "stop.ts", "view.tsx"]))

    for (const file of files) {
      const content = fs.readFileSync(path.join(cockpitDir, file), "utf-8")
      expect(content).not.toContain("OrgRunner.stop(")
      expect(content).not.toContain("OrgRunner.decide(")
    }
  })
})
