// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { OrgRunsPaths } from "../../../src/kilocode/server/httpapi/groups/org-runs"
import { OrgState } from "../../../src/kilocode/organization/state"
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

/** A run with a known total spend of $12 (default budget: run=50, escalationThreshold=10). */
async function seedRunWithSpend(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "a habit tracker for sailors")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["evaluation"].status = "completed"
    s.stages["evaluation"].costs = { ses_a: 8 }
    s.stages["evaluation"].attempts = 1
    s.stages["evaluation"].startedAt = "2026-07-09T00:00:00.000Z"
    s.stages["evaluation"].completedAt = "2026-07-09T00:10:00.000Z"
    s.stages["evaluation"].decision = "approve"
    s.stages["planning"].status = "running"
    s.stages["planning"].costs = { ses_b: 4 }
    s.stages["planning"].attempts = 1
    s.stages["planning"].startedAt = "2026-07-09T00:11:00.000Z"
  })
  return run.runID
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi org-runs budget block", () => {
  test("GET /org-runs/:runID includes a budget block derived from the resolved org budget + run spend", async () => {
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
    expect(budget.stage).toBe(15) // owner-approved default
    expect(budget.escalationThreshold).toBe(10) // owner-approved default
    expect(budget.retries).toBe(2) // owner-approved default
    expect(budget.spent).toBeCloseTo(12, 10) // 8 + 4
    expect(budget.remaining).toBeCloseTo(38, 10) // 50 - 12
    expect(budget.escalated).toBe(false) // run.escalated unset -> false
  })

  test("budget.escalated reflects run.escalated when the run has crossed the escalation gate", async () => {
    await using tmp = await tmpdir()
    await OrgSchema.writeOrganization(tmp.path, ORG)
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)
    await OrgState.update(tmp.path, runID, (s) => {
      s.escalated = true
    })

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const budget = rec(body.budget)
    expect(budget.escalated).toBe(true)
  })

  test("budget.remaining floors at 0 when spend exceeds the run ceiling", async () => {
    await using tmp = await tmpdir()
    await OrgSchema.writeOrganization(tmp.path, ORG)
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)
    await OrgState.update(tmp.path, runID, (s) => {
      s.stages["planning"].costs = { ses_b: 999 } // pushes total spend well past run=50
    })

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const budget = rec(body.budget)
    expect(budget.spent).toBeCloseTo(1007, 10)
    expect(budget.remaining).toBe(0)
  })

  test("GET /org-runs/:runID with no organization.jsonc still returns the run, budget degraded to null", async () => {
    await using tmp = await tmpdir()
    // deliberately do NOT write organization.jsonc
    const api = app()
    const runID = await seedRunWithSpend(tmp.path)

    const response = await api.request(OrgRunsPaths.detail.replace(":runID", runID), {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    expect(body.run).toBeDefined()
    expect(rec(body.run).runID).toBe(runID)
    // Effect Schema.optional serializes an absent value as JSON `null` (not an omitted key) --
    // the handler produces `undefined` on the org-load failure branch, the wire contract surfaces
    // it as `null`. Either way the client's contract is "falsy => no budget available", never a
    // misleading zero-filled budget.
    expect(body.budget).toBeNull()
  })
})
