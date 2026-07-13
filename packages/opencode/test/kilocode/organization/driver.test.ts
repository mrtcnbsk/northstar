import { describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgDriver } from "../../../src/kilocode/organization/driver"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: { build: { chief: "build-chief", workers: ["builder"] } },
  pipeline: [{ stage: "build" }],
  loop: { maxIterations: 2, evaluatorModel: "haiku" },
})

async function seed(dir: string) {
  const run = await OrgRunner.start(dir, ORG, "driver fixture")
  return OrgState.update(dir, run.runID, (state) => {
    state.auto = true
    state.ownerSessionID = "ses_owner"
    state.stages.build.objective = "Build the feature"
    state.stages.build.criteria = ["Focused tests pass"]
  })
}

describe("OrgDriver", () => {
  test("keeps same-id flights isolated by organization", async () => {
    await using tmp = await tmpdir()
    const alpha = await OrgWorkspace.publish(tmp.path, (await OrgWorkspace.stage(tmp.path, "Alpha")).entry.id)
    const beta = await OrgWorkspace.publish(tmp.path, (await OrgWorkspace.stage(tmp.path, "Beta")).entry.id)
    const alphaRun = await OrgWorkspace.run(alpha, () => seed(tmp.path))
    const seededBeta = await OrgWorkspace.run(beta, () => seed(tmp.path))
    const betaRun =
      seededBeta.runID === alphaRun.runID
        ? seededBeta
        : await OrgWorkspace.run(beta, async () => {
            const run = { ...seededBeta, runID: alphaRun.runID }
            await Bun.write(path.join(OrgState.runDir(tmp.path, run.runID), "state.json"), JSON.stringify(run))
            await rm(OrgState.runDir(tmp.path, seededBeta.runID), { recursive: true })
            return run
          })
    expect(alphaRun.runID).toBe(betaRun.runID)

    const spawns: string[] = []
    const runtime = (organizationID: string): OrgDriver.Runtime => ({
      costOf: async () => 1,
      spawnChief: async ({ runID, stage }) => {
        spawns.push(organizationID)
        await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, stage), `result ${"evidence ".repeat(20)}`)
        return { taskID: `ses_${organizationID}`, cost: 1, toolIDs: [] }
      },
      evaluate: async () => '{"pass":true}',
    })

    const alphaFlight = OrgDriver.attach({
      projectDir: tmp.path,
      organization: alpha,
      org: ORG,
      runID: alphaRun.runID,
      runtime: runtime("alpha"),
    })
    const betaFlight = OrgDriver.attach({
      projectDir: tmp.path,
      organization: beta,
      org: ORG,
      runID: betaRun.runID,
      runtime: runtime("beta"),
    })
    expect(OrgDriver.isAttached(tmp.path, alphaRun.runID, alpha)).toBe(true)
    expect(OrgDriver.isAttached(tmp.path, betaRun.runID, beta)).toBe(true)

    const outcomes = await Promise.all([alphaFlight, betaFlight])

    expect(outcomes).toEqual([{ type: "completed" }, { type: "completed" }])
    expect(spawns.sort()).toEqual(["alpha", "beta"])
    expect((await OrgWorkspace.run(alpha, () => OrgState.read(tmp.path, alphaRun.runID))).status).toBe("completed")
    expect((await OrgWorkspace.run(beta, () => OrgState.read(tmp.path, betaRun.runID))).status).toBe("completed")
  })

  test("single-flights duplicate attach calls for one project/run", async () => {
    await using tmp = await tmpdir()
    const run = await seed(tmp.path)
    let spawns = 0
    const costs = new Map<string, number>()
    const runtime: OrgDriver.Runtime = {
      costOf: async (taskID) => costs.get(taskID),
      spawnChief: async ({ runID, stage }) => {
        spawns += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, stage), `result ${"evidence ".repeat(20)}`)
        costs.set("ses_build", 1)
        return { taskID: "ses_build", cost: 1, toolIDs: [] }
      },
      evaluate: async () => '{"pass":true}',
    }

    const first = OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID: run.runID, runtime })
    const second = OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID: run.runID, runtime })
    expect(OrgDriver.isAttached(tmp.path, run.runID)).toBe(true)
    expect(await Promise.all([first, second])).toEqual([{ type: "completed" }, { type: "completed" }])
    expect(spawns).toBe(1)
    expect(OrgDriver.isAttached(tmp.path, run.runID)).toBe(false)
  })

  test("can attach again after an escalation is steered and resumed", async () => {
    await using tmp = await tmpdir()
    const run = await seed(tmp.path)
    let reply = '{"pass":false,"reasons":["missing proof"]}'
    let count = 0
    const costs = new Map<string, number>()
    const runtime: OrgDriver.Runtime = {
      costOf: async (taskID) => costs.get(taskID),
      spawnChief: async ({ runID, stage }) => {
        count += 1
        const taskID = `ses_build_${count}`
        costs.set(taskID, 1)
        await Bun.write(OrgArtifacts.deliverablePath(tmp.path, runID, stage), `v${count} ${"evidence ".repeat(20)}`)
        return { taskID, cost: 1, toolIDs: [] }
      },
      evaluate: async () => reply,
    }

    const paused = await OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID: run.runID, runtime })
    expect(paused.type).toBe("paused")
    await OrgRunner.resume(tmp.path, ORG, run.runID, "cite the command output")
    reply = '{"pass":true}'
    expect(await OrgDriver.attach({ projectDir: tmp.path, org: ORG, runID: run.runID, runtime })).toEqual({
      type: "completed",
    })
  })

  test("sessionRuntime resumes owned children, chooses the provider small model, and denies evaluator tools", async () => {
    const created: OrgDriver.SessionCreateInput[] = []
    const prompted: OrgDriver.SessionPromptInput[] = []
    const sessions = new Map<string, OrgDriver.SessionInfo>([
      ["ses_owner", { id: "ses_owner", cost: 0, model: { providerID: "anthropic", modelID: "sonnet" } }],
      ["ses_resume", { id: "ses_resume", parentID: "ses_owner", cost: 3 }],
    ])
    let sequence = 0
    const bridge: OrgDriver.SessionBridge = {
      get: async (sessionID) => sessions.get(sessionID),
      create: async (input) => {
        created.push(input)
        const session = { id: `ses_new_${++sequence}`, parentID: input.parentID, cost: 0, model: input.model }
        sessions.set(session.id, session)
        return session
      },
      prompt: async (input) => {
        prompted.push(input)
        const session = sessions.get(input.sessionID)!
        session.cost += 2
        return input.agent === "general" ? '{"pass":true}' : "READY"
      },
      messages: async (sessionID) =>
        sessionID === "ses_resume" ? [{ parts: [{ type: "tool", tool: "xcode_test" }] }] : [],
      smallModel: async (providerID) => ({ providerID, modelID: "claude-haiku-4-5" }),
    }
    const runtime = OrgDriver.sessionRuntime({ ownerSessionID: "ses_owner", bridge })

    const chief = await runtime.spawnChief({
      runID: "run",
      stage: "build",
      chief: "build-chief",
      instruction: "do the work",
      resumeTaskID: "ses_resume",
    })
    expect(chief).toEqual({ taskID: "ses_resume", cost: 5, toolIDs: ["xcode_test"] })

    expect(await runtime.evaluate({ runID: "run", stage: "build", model: "haiku", prompt: "judge" })).toBe(
      '{"pass":true}',
    )
    const evaluator = created.at(-1)!
    expect(evaluator.agent).toBe("general")
    expect(evaluator.model).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
    expect(evaluator.permission).toEqual([{ permission: "*", pattern: "*", action: "deny" }])
    expect(prompted.at(-1)?.tools).toMatchObject({ task: false, bash: false, edit: false, question: false })
  })

  test("sessionRuntime honors an explicit provider/model evaluator override", async () => {
    const created: OrgDriver.SessionCreateInput[] = []
    const bridge: OrgDriver.SessionBridge = {
      get: async () => ({ id: "ses_owner", cost: 0, model: { providerID: "anthropic", modelID: "sonnet" } }),
      create: async (input) => {
        created.push(input)
        return { id: "ses_eval", parentID: input.parentID, cost: 0, model: input.model }
      },
      prompt: async () => '{"pass":true}',
      messages: async () => [],
      smallModel: async () => undefined,
    }
    const runtime = OrgDriver.sessionRuntime({ ownerSessionID: "ses_owner", bridge })
    await runtime.evaluate({ runID: "run", stage: "build", model: "openai/gpt-5-mini", prompt: "judge" })
    expect(created[0].model).toEqual({ providerID: "openai", modelID: "gpt-5-mini" })
  })
})
