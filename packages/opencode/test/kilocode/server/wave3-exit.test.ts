// kilocode_change - new file
/**
 * Wave 3 (observability) EXIT TEST, made executable against the REAL org-runs HTTP API.
 *
 * Exit criterion (from the wave plan): "a live dashboard tracks a running org; a gate shows as a
 * notification; the cost panel matches state.json to the cent."
 *
 * This test fabricates one multi-stage run (evaluation completed+approved, planning
 * awaiting_approval, backend pending), drives GET /org-runs and GET /org-runs/:runID over the
 * same harness as httpapi-org-runs.test.ts, and asserts the responses give a dashboard everything
 * it needs: an awaiting-gate flag a console can turn into a badge, and a totalCost that matches
 * the state.json stage-cost sum to the cent (not just "close enough" float equality).
 */
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { OrgRunsPaths } from "../../../src/kilocode/server/httpapi/groups/org-runs"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgAudit } from "../../../src/kilocode/organization/audit"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

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
    backend: { chief: "backend-chief", workers: ["engineer"] },
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }, { stage: "backend" }],
})

// Seed cost values chosen so a naive running-float sum can drift from the cent-rounded total:
// 12.5 + 0.37 = 12.87 (evaluation), + 1.13 (planning) = 14.00 exactly at the cent, but summing in
// IEEE754 double precision in a different grouping/order is a classic source of a
// 13.999999999999998-style result. Computed independently below from the raw seed numbers (not
// read back from the API), so the assertions are honest to-the-cent checks, not tautologies.
const EVAL_COSTS = { ses1: 12.5, ses2: 0.37 } // 12.87
const PLANNING_COSTS = { ses3: 1.13 } // 1.13
const evalTotal = Object.values(EVAL_COSTS).reduce((s, c) => s + c, 0)
const planningTotal = Object.values(PLANNING_COSTS).reduce((s, c) => s + c, 0)
const expectedTotalCost = evalTotal + planningTotal // 14.00
const expectedCents = Math.round(EVAL_COSTS.ses1 * 100 + EVAL_COSTS.ses2 * 100 + PLANNING_COSTS.ses3 * 100) // 1400

/**
 * The Wave 3 exit fixture: evaluation completed+approved (with a gate audit entry), planning
 * awaiting_approval (the live gate the dashboard must surface as a notification), backend still
 * pending with no cost yet.
 */
async function seedExitRun(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "a wave 3 exit fixture")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["evaluation"].status = "completed"
    s.stages["evaluation"].costs = { ...EVAL_COSTS }
    s.stages["evaluation"].attempts = 1
    s.stages["evaluation"].startedAt = "2026-07-09T00:00:00.000Z"
    s.stages["evaluation"].completedAt = "2026-07-09T00:10:00.000Z"
    s.stages["evaluation"].decision = "approve"

    s.stages["planning"].status = "awaiting_approval"
    s.stages["planning"].costs = { ...PLANNING_COSTS }
    s.stages["planning"].attempts = 1
    s.stages["planning"].startedAt = "2026-07-09T00:11:00.000Z"

    // backend stays "pending", no costs -- exercises the "no cost yet" branch of the cost panel.
  })
  await OrgAudit.append(projectDir, run.runID, {
    ts: "2026-07-09T00:10:00.000Z",
    stage: "evaluation",
    decision: "approve",
    deliverableHash: "wave3-exit-hash",
  })
  return run.runID
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("Wave 3 exit: org-runs HTTP API satisfies dashboard/gate/cost-to-the-cent", () => {
  test("dashboard list: awaiting gate, current stage, and totalCost to the cent", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const runID = await seedExitRun(tmp.path)

    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const runs = body.runs as Json[]
    const run = runs.find((r) => r.runID === runID)!

    expect(run.status).toBe("active")
    expect(run.awaitingGate).toBe(true)
    expect(run.currentStage).toBe("planning")
    expect(run.stageCount).toBe(3)

    // "to the cent": both a tolerant float comparison and a literal integer-cents comparison.
    expect(run.totalCost).toBeCloseTo(expectedTotalCost, 10)
    expect(Math.round((run.totalCost as number) * 100)).toBe(expectedCents)
  })

  test("gate-as-notification and cost panel to the cent: run detail", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const runID = await seedExitRun(tmp.path)

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const stages = body.stages as Json[]

    // Gate-as-notification: the surface a console turns into an "AWAITING APPROVAL" badge.
    const planning = stages.find((s) => s.stage === "planning")!
    expect(planning.status).toBe("awaiting_approval")
    expect(planning.cost).toBeCloseTo(planningTotal, 10)
    expect(Math.round((planning.cost as number) * 100)).toBe(113)

    const evaluation = stages.find((s) => s.stage === "evaluation")!
    expect(evaluation.status).toBe("completed")
    expect(evaluation.decision).toBe("approve")
    expect(evaluation.startedAt).toBe("2026-07-09T00:00:00.000Z")
    expect(evaluation.completedAt).toBe("2026-07-09T00:10:00.000Z")
    expect(evaluation.cost).toBeCloseTo(evalTotal, 10)
    expect(Math.round((evaluation.cost as number) * 100)).toBe(1287)

    const backend = stages.find((s) => s.stage === "backend")!
    expect(backend.status).toBe("pending")
    expect(backend.cost).toBe(0)

    // Audit trail carries the approval that unblocked evaluation -> planning.
    expect(body.audit).toEqual([
      {
        ts: "2026-07-09T00:10:00.000Z",
        stage: "evaluation",
        decision: "approve",
        deliverableHash: "wave3-exit-hash",
      },
    ])

    // Cost panel to the cent: sum of what the panel renders per stage === run total === seed.
    const panelSum = stages.reduce((sum, s) => sum + (s.cost as number), 0)
    expect(panelSum).toBeCloseTo(expectedTotalCost, 10)
    expect(Math.round(panelSum * 100)).toBe(expectedCents)

    expect(body.totalCost).toBeCloseTo(expectedTotalCost, 10)
    expect(Math.round((body.totalCost as number) * 100)).toBe(expectedCents)
    expect(body.totalCost).toBe(panelSum)
  })

  // Guards: kept light since the negative/empty paths are already exercised in
  // httpapi-org-runs.test.ts; re-asserted here so this exit test stands alone.
  test("guard: unknown runID -> 404", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const response = await api.request(OrgRunsPaths.detail.replace(":runID", "no-such-run"), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(404)
  })

  test("guard: fresh workspace with no runs -> {runs: []}", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    expect(body).toEqual({ runs: [] })
  })
})
