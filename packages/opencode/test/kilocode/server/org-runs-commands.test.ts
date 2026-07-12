import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import * as Log from "@opencode-ai/core/util/log"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgRunsPaths } from "../../../src/kilocode/server/httpapi/groups/org-runs"
import * as HttpApiServer from "../../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

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

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["planner"] },
    build: { chief: "build-chief", workers: ["builder"] },
  },
  pipeline: [{ stage: "plan", gate: "human" }, { stage: "build" }],
})

const plan = [
  { stage: "plan", objective: "Approve scope", criteria: ["Scope is measurable"], agents: ["planner"] },
  { stage: "build", objective: "Build scope", criteria: ["Focused tests pass"], agents: ["builder"] },
]

async function seedPlanGate(dir: string) {
  await mkdir(path.join(dir, ".kilo"), { recursive: true })
  await Bun.write(OrgSchema.organizationPath(dir), JSON.stringify(ORG))
  const run = await OrgRunner.start(dir, ORG, "HTTP command fixture")
  await OrgRunner.advance({ costOf: async () => 0 }, dir, ORG, run.runID, {})
  await Bun.write(OrgArtifacts.deliverablePath(dir, run.runID, "plan"), `plan ${"evidence ".repeat(20)}`)
  await OrgRunner.advance({ costOf: async () => 0 }, dir, ORG, run.runID, { taskID: "ses_plan" })
  return run.runID
}

function commandPath(pathname: string, runID: string) {
  return pathname.replace(":runID", runID)
}

function post(api: ReturnType<typeof app>, pathname: string, dir: string, payload: unknown) {
  return api.request(pathname, {
    method: "POST",
    headers: { "content-type": "application/json", "x-kilo-directory": dir },
    body: JSON.stringify(payload),
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("HttpApi org-runs commands", () => {
  test("plan -> decision -> note -> manual pause/resume -> stop uses the same run state machine", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const runID = await seedPlanGate(tmp.path)

    let response = await post(api, commandPath(OrgRunsPaths.plan, runID), tmp.path, { stages: plan })
    expect(response.status).toBe(200)
    expect((await response.json()).status).toBe("active")
    expect((await OrgState.read(tmp.path, runID)).auto).toBe(false)

    response = await post(api, commandPath(OrgRunsPaths.decision, runID), tmp.path, {
      decision: "approve",
      stage: "plan",
    })
    expect(response.status).toBe(200)
    expect((await OrgState.read(tmp.path, runID)).auto).toBe(true)

    response = await post(api, commandPath(OrgRunsPaths.note, runID), tmp.path, {
      target_agent: "builder",
      text: "Include the exact test command",
    })
    expect(response.status).toBe(200)
    expect((await OrgState.read(tmp.path, runID)).notes?.[0].text).toBe("Include the exact test command")

    response = await post(api, commandPath(OrgRunsPaths.pause, runID), tmp.path, { detail: "operator pause" })
    expect(response.status).toBe(200)
    expect((await OrgState.read(tmp.path, runID)).pausedReason?.kind).toBe("manual")

    response = await post(api, commandPath(OrgRunsPaths.resume, runID), tmp.path, {})
    expect(response.status).toBe(200)
    expect((await OrgState.read(tmp.path, runID)).status).toBe("active")

    response = await post(api, commandPath(OrgRunsPaths.stop, runID), tmp.path, { reason: "cancelled by operator" })
    expect(response.status).toBe(200)
    const stopped = await OrgState.read(tmp.path, runID)
    expect(stopped.status).toBe("halted")
    expect(stopped.haltReason).toContain("cancelled by operator")
  })

  test("rejects schema-invalid bodies and wrong-stage decisions with 400", async () => {
    await using tmp = await tmpdir()
    const api = app()
    const runID = await seedPlanGate(tmp.path)

    expect((await post(api, commandPath(OrgRunsPaths.stop, runID), tmp.path, {})).status).toBe(400)
    expect(
      (
        await post(api, commandPath(OrgRunsPaths.decision, runID), tmp.path, {
          decision: "approve",
          stage: "build",
        })
      ).status,
    ).toBe(400)
  })

  test("maps unknown and traversal-rejected run IDs to 404", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(OrgSchema.organizationPath(tmp.path), JSON.stringify(ORG))
    const api = app()

    expect((await post(api, commandPath(OrgRunsPaths.stop, "no-such-run"), tmp.path, { reason: "x" })).status).toBe(404)
    expect((await post(api, commandPath(OrgRunsPaths.stop, "..%2Fsecret"), tmp.path, { reason: "x" })).status).toBe(404)
  })

  test("does not disguise a corrupt existing state file as 400/404", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(OrgSchema.organizationPath(tmp.path), JSON.stringify(ORG))
    const runID = "20260712-000000-corrupt"
    await Bun.write(path.join(OrgState.runDir(tmp.path, runID), "state.json"), "{broken")
    const api = app()

    const response = await post(api, commandPath(OrgRunsPaths.stop, runID), tmp.path, { reason: "x" })
    expect(response.status).toBe(500)
  })
})
