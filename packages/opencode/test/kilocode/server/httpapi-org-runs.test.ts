// kilocode_change - new file
import path from "path"
import { promises as fs } from "node:fs"
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
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

/** A run mid-gate: evaluation completed with cost, planning awaiting approval with cost. */
async function seedAwaitingRun(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "a habit tracker for sailors")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["evaluation"].status = "completed"
    s.stages["evaluation"].costs = { ses_a: 1.5, ses_b: 0.25 } // 1.75
    s.stages["evaluation"].attempts = 1
    s.stages["evaluation"].startedAt = "2026-07-09T00:00:00.000Z"
    s.stages["evaluation"].completedAt = "2026-07-09T00:10:00.000Z"
    s.stages["evaluation"].decision = "approve"
    s.stages["planning"].status = "awaiting_approval"
    s.stages["planning"].costs = { ses_c: 0.5 } // 0.5
    s.stages["planning"].attempts = 1
    s.stages["planning"].startedAt = "2026-07-09T00:11:00.000Z"
  })
  await OrgAudit.append(projectDir, run.runID, {
    ts: "2026-07-09T00:10:00.000Z",
    stage: "evaluation",
    decision: "approve",
    deliverableHash: "abc123",
  })
  return run.runID
}

/** A fully completed run, no gate pending, using the legacy single-slot `cost` field. */
async function seedCompletedRun(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "a second idea")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.status = "completed"
    s.stages["evaluation"].status = "completed"
    s.stages["evaluation"].cost = 2 // legacy single-slot fallback
    s.stages["evaluation"].completedAt = "2026-07-09T01:00:00.000Z"
    s.stages["planning"].status = "completed"
    s.stages["planning"].costs = { ses_d: 3 }
    s.stages["planning"].completedAt = "2026-07-09T02:00:00.000Z"
  })
  return run.runID
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi org-runs", () => {
  test("GET /org-runs returns {runs: []} for a fresh workspace with no runs", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    expect(body).toEqual({ runs: [] })
  })

  test("GET /org-runs returns newest-first summaries after creating two runs", async () => {
    await using tmp = await tmpdir()
    const api = app()

    const completedID = await seedCompletedRun(tmp.path)
    await new Promise((r) => setTimeout(r, 1100)) // runID has second granularity; ensure ordering
    const awaitingID = await seedAwaitingRun(tmp.path)

    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const runs = body.runs as Json[]
    expect(runs.map((r) => r.runID)).toEqual([awaitingID, completedID])

    const awaiting = runs.find((r) => r.runID === awaitingID)!
    expect(awaiting.idea).toBe("a habit tracker for sailors")
    expect(awaiting.status).toBe("active")
    expect(awaiting.totalCost).toBeCloseTo(2.25, 10)
    expect(awaiting.stageCount).toBe(2)
    expect(awaiting.awaitingGate).toBe(true)
    expect(awaiting.currentStage).toBe("planning")

    const completed = runs.find((r) => r.runID === completedID)!
    expect(completed.status).toBe("completed")
    expect(completed.totalCost).toBeCloseTo(5, 10)
    expect(completed.awaitingGate).toBe(false)
    expect(completed.currentStage).toBeNull()
  })

  test("GET /org-runs/:runID returns full detail with stages and audit", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const runID = await seedAwaitingRun(tmp.path)

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())

    const run = rec(body.run)
    expect(run.runID).toBe(runID)
    expect(run.idea).toBe("a habit tracker for sailors")
    expect(body.totalCost).toBeCloseTo(2.25, 10)

    expect(body.audit).toEqual([
      { ts: "2026-07-09T00:10:00.000Z", stage: "evaluation", decision: "approve", deliverableHash: "abc123" },
    ])

    const stages = body.stages as Json[]
    const evaluation = stages.find((s) => s.stage === "evaluation")!
    expect(evaluation.status).toBe("completed")
    expect(evaluation.cost).toBeCloseTo(1.75, 10)
    expect(evaluation.attempts).toBe(1)
    expect(evaluation.startedAt).toBe("2026-07-09T00:00:00.000Z")
    expect(evaluation.completedAt).toBe("2026-07-09T00:10:00.000Z")
    expect(evaluation.decision).toBe("approve")

    const planning = stages.find((s) => s.stage === "planning")!
    expect(planning.status).toBe("awaiting_approval")
    expect(planning.cost).toBeCloseTo(0.5, 10)
    expect(planning.completedAt).toBeNull()
    expect(planning.decision).toBeNull()
  })

  test("GET detail surfaces autonomous criteria, loop progress, pause reason, and conductor events", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    const autoOrg = OrgSchema.parse({
      ...ORG,
      loop: { maxIterations: 6, evaluatorModel: "haiku-fast" },
      pipeline: [
        { ...ORG.pipeline[0], criteria: ["Evidence is cited"] },
        { ...ORG.pipeline[1], criteria: ["Focused tests pass"] },
      ],
    })
    await Bun.write(OrgSchema.organizationPath(tmp.path), JSON.stringify(autoOrg))
    const run = await OrgState.create(tmp.path, autoOrg, "autonomous telemetry")
    await OrgState.update(tmp.path, run.runID, (state) => {
      state.auto = true
      state.status = "paused"
      state.pausedReason = { kind: "escalation", stage: "planning", detail: "test proof missing" }
      state.stages.evaluation.status = "completed"
      state.stages.planning.status = "awaiting_approval"
      state.stages.planning.objective = "Prove readiness"
      state.stages.planning.iterations = 2
      state.stages.planning.toolsUsed = ["xcode_test"]
      state.stages.planning.verdictHistory = [
        { pass: false, reasons: ["test proof missing"], summary: "revise", ts: 1234 },
      ]
    })
    await OrgAudit.append(tmp.path, run.runID, {
      ts: "2026-07-12T00:00:00.000Z",
      stage: "planning",
      decision: "event",
      event: "evaluator_verdict",
      pass: false,
      iteration: 2,
      note: "test proof missing",
    })

    const response = await app().request(OrgRunsPaths.detail.replace(":runID", run.runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const returned = rec(body.run)
    expect(returned.auto).toBe(true)
    expect(returned.pausedReason).toEqual({ kind: "escalation", stage: "planning", detail: "test proof missing" })
    expect(body.loop).toEqual({ maxIterations: 6, evaluatorModel: "haiku-fast" })
    const planning = (body.stages as Json[]).find((stage) => stage.stage === "planning")!
    expect(planning.criteria).toEqual(["Focused tests pass"])
    expect(planning.objective).toBe("Prove readiness")
    expect(planning.iterations).toBe(2)
    expect(planning.toolsUsed).toEqual(["xcode_test"])
    expect((body.audit as Json[])[0]).toMatchObject({
      event: "evaluator_verdict",
      pass: false,
      iteration: 2,
    })
  })

  test("GET /org-runs/:unknownID returns 404", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const response = await api.request(OrgRunsPaths.detail.replace(":runID", "no-such-run"), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(404)
  })

  test("GET /org-runs skips a run with truncated (unparsable) state.json, keeps healthy runs, newest first", async () => {
    await using tmp = await tmpdir()
    const api = app()

    const completedID = await seedCompletedRun(tmp.path)
    await new Promise((r) => setTimeout(r, 1100))
    const awaitingID = await seedAwaitingRun(tmp.path)

    // A third run directory whose state.json is truncated mid-write -- simulates a crash during save.
    const corruptID = "20260709-999999-corrupt-truncated"
    await Bun.write(path.join(tmp.path, ".kilo", "org", "runs", corruptID, "state.json"), "{ not json")

    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const runs = body.runs as Json[]
    expect(runs.map((r) => r.runID)).toEqual([awaitingID, completedID])
    expect(runs.some((r) => r.runID === corruptID)).toBe(false)
  })

  test("GET /org-runs skips a run whose state.json is valid JSON but schema-invalid", async () => {
    await using tmp = await tmpdir()
    const api = app()

    const completedID = await seedCompletedRun(tmp.path)
    await new Promise((r) => setTimeout(r, 1100))
    const awaitingID = await seedAwaitingRun(tmp.path)

    const invalidID = "20260709-999998-schema-invalid"
    await Bun.write(
      path.join(tmp.path, ".kilo", "org", "runs", invalidID, "state.json"),
      JSON.stringify({ runID: invalidID, status: "bogus-status" }),
    )

    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const runs = body.runs as Json[]
    expect(runs.map((r) => r.runID)).toEqual([awaitingID, completedID])
    expect(runs.some((r) => r.runID === invalidID)).toBe(false)
  })

  test("GET /org-runs skips a stray run subdirectory with no state.json at all", async () => {
    await using tmp = await tmpdir()
    const api = app()

    const completedID = await seedCompletedRun(tmp.path)

    const strayID = "20260709-999997-stray-empty-dir"
    await fs.mkdir(path.join(tmp.path, ".kilo", "org", "runs", strayID), { recursive: true })

    const response = await api.request(OrgRunsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const runs = body.runs as Json[]
    expect(runs.map((r) => r.runID)).toEqual([completedID])
  })

  test("GET /org-runs/:runID returns 500 (not 404) for a run that exists but has corrupt state.json", async () => {
    await using tmp = await tmpdir()
    const api = app()

    const corruptID = "20260709-999996-corrupt-detail"
    await Bun.write(path.join(tmp.path, ".kilo", "org", "runs", corruptID, "state.json"), "{ not json")

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", corruptID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(500)
    const text = await response.text()
    // Must not leak the absolute filesystem path of state.json in the response body.
    expect(text).not.toContain(tmp.path)
    expect(text).not.toContain("state.json")
  })

  test("GET /org-runs/:runID degrades gracefully when approvals.json is corrupt: 200 with empty audit", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const runID = await seedAwaitingRun(tmp.path)

    // Corrupt the audit file after seeding a healthy run.
    await Bun.write(path.join(tmp.path, ".kilo", "org", "runs", runID, "approvals.json"), "{ not json")

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    expect(body.audit).toEqual([])
    const run = rec(body.run)
    expect(run.runID).toBe(runID)
    const stages = body.stages as Json[]
    expect(stages.length).toBe(2)
  })
})
