// kilocode_change - new file
import path from "path"
import { promises as fs } from "node:fs"
import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { AgentsPaths } from "../../../src/kilocode/server/httpapi/groups/agents"
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

const ORG_RAW = {
  ceo: "ceo",
  departments: {
    plan: { chief: "planning-chief", workers: ["architect"] },
    build: { chief: "build-chief", workers: ["swiftui-dev"] },
    marketing: { chief: "marketing-chief", workers: ["copywriter"] },
  },
  pipeline: [{ stage: "plan" }, { stage: "build" }, { stage: "marketing" }],
}

const ORG = OrgSchema.parse(ORG_RAW)

/** Writes organization.jsonc to disk so OrgMetrics.collect (loadOrganization) can map stage -> chief. */
async function writeOrgFile(projectDir: string): Promise<void> {
  await Bun.write(OrgSchema.organizationPath(projectDir), JSON.stringify(ORG_RAW))
}

/** Run 1: every stage completed, known costs and full timestamps on plan/build. */
async function seedRun1(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "first idea")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["plan"].status = "completed"
    s.stages["plan"].costs = { ses_p1: 1.25 }
    s.stages["plan"].attempts = 1
    s.stages["plan"].startedAt = "2026-07-11T12:00:00.000Z"
    s.stages["plan"].completedAt = "2026-07-11T12:10:00.000Z"
    s.stages["build"].status = "completed"
    s.stages["build"].costs = { ses_b1: 2, ses_b2: 1 }
    s.stages["build"].attempts = 2
    s.stages["build"].startedAt = "2026-07-11T12:10:00.000Z"
    s.stages["build"].completedAt = "2026-07-11T12:30:00.000Z"
    s.stages["marketing"].status = "completed"
    s.stages["marketing"].costs = { ses_m1: 0.5 }
    s.stages["marketing"].attempts = 1
  })
  return run.runID
}

/** Run 2: plan completed, build FAILED (no cost), marketing awaiting_approval (blocked). */
async function seedRun2(projectDir: string): Promise<string> {
  const run = await OrgState.create(projectDir, ORG, "second idea")
  await OrgState.update(projectDir, run.runID, (s) => {
    s.stages["plan"].status = "completed"
    s.stages["plan"].costs = { ses_p2: 0.75 }
    s.stages["plan"].attempts = 1
    s.stages["build"].status = "failed"
    s.stages["build"].attempts = 2
    s.stages["build"].incompleteAttempts = 2
    s.stages["marketing"].status = "awaiting_approval"
    s.stages["marketing"].costs = { ses_m2: 0.25 }
    s.stages["marketing"].attempts = 1
  })
  return run.runID
}

const cents = (n: unknown): number => Math.round((n as number) * 100)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi agents", () => {
  test("GET /agents returns {agents: []} for a fresh workspace with no runs and no organization.jsonc", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const response = await api.request(AgentsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    expect(body).toEqual({ agents: [] })
  })

  test("GET /agents returns per-chief rollup rows with summed cost, counts, and health band across two runs", async () => {
    await using tmp = await tmpdir()
    await writeOrgFile(tmp.path)
    const api = app()

    await seedRun1(tmp.path)
    await seedRun2(tmp.path)

    const response = await api.request(AgentsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const agents = body.agents as Json[]
    expect(agents).toHaveLength(3)
    const byAgent = Object.fromEntries(agents.map((a) => [a.agent, a]))

    // planning-chief: both runs' plan stages completed, no failures -> healthy, full score.
    const planning = byAgent["planning-chief"]
    expect(planning.runs).toBe(2)
    expect(planning.stages).toBe(2)
    expect(cents(planning.totalCost)).toBe(200) // 1.25 + 0.75
    expect(planning.completed).toBe(2)
    expect(planning.failed).toBe(0)
    expect(planning.blocked).toBe(0)
    expect(planning.successRate).toBe(1)
    const planningHealth = rec(planning.health)
    expect(planningHealth.band).toBe("healthy")
    expect(planningHealth.score).toBe(100)

    // build-chief: 1 completed + 1 failed -> 50% error rate exceeds the 20% ceiling -> unhealthy.
    const build = byAgent["build-chief"]
    expect(build.runs).toBe(2)
    expect(build.stages).toBe(2)
    expect(cents(build.totalCost)).toBe(300) // 2 + 1 from run1; run2's failed build has no cost
    expect(build.completed).toBe(1)
    expect(build.failed).toBe(1)
    expect(build.successRate).toBe(0.5)
    const buildHealth = rec(build.health)
    expect(buildHealth.band).toBe("unhealthy")
    expect(buildHealth.score).toBeLessThan(50)

    // marketing-chief: 1 completed + 1 awaiting_approval (blocked, non-terminal) -> healthy.
    const marketing = byAgent["marketing-chief"]
    expect(marketing.runs).toBe(2)
    expect(marketing.stages).toBe(2)
    expect(cents(marketing.totalCost)).toBe(75) // 0.5 + 0.25
    expect(marketing.completed).toBe(1)
    expect(marketing.blocked).toBe(1)
    expect(marketing.successRate).toBe(1)
    const marketingHealth = rec(marketing.health)
    expect(marketingHealth.band).toBe("healthy")
  })

  test("GET /agents skips a run with corrupt (unparsable) state.json, still 200, healthy runs' rollup unaffected", async () => {
    await using tmp = await tmpdir()
    await writeOrgFile(tmp.path)
    const api = app()

    await seedRun1(tmp.path)

    const corruptID = "20260711-999999-corrupt"
    await Bun.write(path.join(tmp.path, ".kilo", "org", "runs", corruptID, "state.json"), "{ not json")

    const response = await api.request(AgentsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(200)
    const body = rec(await response.json())
    const agents = body.agents as Json[]
    const byAgent = Object.fromEntries(agents.map((a) => [a.agent, a]))

    // Only run1's stages are reflected; the corrupt run contributes nothing anywhere.
    expect(byAgent["planning-chief"].runs).toBe(1)
    expect(cents(byAgent["planning-chief"].totalCost)).toBe(125)
    expect(byAgent["build-chief"].runs).toBe(1)
    expect(cents(byAgent["build-chief"].totalCost)).toBe(300)
  })

  test("GET /agents returns 500 (not a stack trace) and does not leak tmp.path or state.json when the runs directory itself is unreadable", async () => {
    await using tmp = await tmpdir()
    const api = app()

    // Force OrgState.list to throw a non-ENOENT error: `.kilo/org/runs` exists but is a FILE, so
    // readdir() fails with ENOTDIR instead of the "no runs yet" ENOENT case.
    await fs.mkdir(path.join(tmp.path, ".kilo", "org"), { recursive: true })
    await Bun.write(path.join(tmp.path, ".kilo", "org", "runs"), "not a directory")

    const response = await api.request(AgentsPaths.list, {
      headers: { "x-kilo-directory": tmp.path },
    })
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(text).not.toContain(tmp.path)
    expect(text).not.toContain("state.json")
  })
})
