// kilocode_change - SP1 single-flight headless autonomous driver
import { OrgConductor } from "./conductor"
import { OrgSchema } from "./schema"

export namespace OrgDriver {
  export type ModelRef = { providerID: string; modelID: string }
  export type SessionInfo = { id: string; parentID?: string; cost: number; model?: ModelRef }
  export type SessionCreateInput = {
    parentID: string
    title: string
    agent: string
    model?: ModelRef
    permission?: Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>
  }
  export type SessionPromptInput = {
    sessionID: string
    agent: string
    model?: ModelRef
    text: string
    tools: Record<string, boolean>
  }
  export interface SessionBridge {
    get(sessionID: string): Promise<SessionInfo | undefined>
    create(input: SessionCreateInput): Promise<SessionInfo>
    prompt(input: SessionPromptInput): Promise<string>
    messages(sessionID: string): Promise<Array<{ parts: Array<{ type: string; tool?: string }> }>>
    smallModel(providerID: string): Promise<ModelRef | undefined>
  }

  export interface Runtime {
    costOf(taskID: string): Promise<number | undefined>
    spawnChief(input: {
      runID: string
      stage: string
      chief: string
      instruction: string
      resumeTaskID?: string
    }): Promise<{ taskID: string; cost: number; toolIDs?: string[] }>
    evaluate(input: { runID: string; stage: string; model: string; prompt: string }): Promise<string>
  }

  const evaluatorTools = {
    task: false,
    bash: false,
    edit: false,
    write: false,
    question: false,
    interactive_terminal: false,
  }

  function explicitModel(value: string): ModelRef | undefined {
    const slash = value.indexOf("/")
    if (slash <= 0 || slash === value.length - 1) return undefined
    return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
  }

  export function sessionRuntime(input: { ownerSessionID: string; bridge: SessionBridge }): Runtime {
    return {
      costOf: async (taskID) => (await input.bridge.get(taskID))?.cost,
      spawnChief: async (task) => {
        const resumable = task.resumeTaskID ? await input.bridge.get(task.resumeTaskID) : undefined
        const session =
          resumable?.parentID === input.ownerSessionID
            ? resumable
            : await input.bridge.create({
                parentID: input.ownerSessionID,
                title: `${task.stage} autonomous stage (@${task.chief})`,
                agent: task.chief,
              })
        await input.bridge.prompt({
          sessionID: session.id,
          agent: task.chief,
          text: task.instruction,
          tools: { question: false, interactive_terminal: false },
        })
        const settled = (await input.bridge.get(session.id)) ?? session
        const messages = await input.bridge.messages(session.id)
        const toolIDs = [
          ...new Set(
            messages.flatMap((message) =>
              message.parts.flatMap((part) => (part.type === "tool" && part.tool ? [part.tool] : [])),
            ),
          ),
        ]
        return { taskID: session.id, cost: settled.cost, toolIDs }
      },
      evaluate: async (request) => {
        const owner = await input.bridge.get(input.ownerSessionID)
        if (!owner) throw new Error(`Autonomous run owner session ${input.ownerSessionID} no longer exists`)
        const model =
          explicitModel(request.model) ??
          (owner.model ? await input.bridge.smallModel(owner.model.providerID) : undefined) ??
          owner.model
        const session = await input.bridge.create({
          parentID: input.ownerSessionID,
          title: `${request.stage} acceptance evaluator`,
          agent: "general",
          model,
          permission: [{ permission: "*", pattern: "*", action: "deny" }],
        })
        return input.bridge.prompt({
          sessionID: session.id,
          agent: "general",
          model,
          text: request.prompt,
          tools: evaluatorTools,
        })
      },
    }
  }

  const flights = new Map<string, Promise<OrgConductor.Outcome>>()
  const key = (projectDir: string, runID: string) => `${projectDir}\0${runID}`

  export function isAttached(projectDir: string, runID: string): boolean {
    return flights.has(key(projectDir, runID))
  }

  export function attach(input: {
    projectDir: string
    org: OrgSchema.Organization
    runID: string
    runtime: Runtime
    lock?: <A>(fn: () => Promise<A>) => Promise<A>
  }): Promise<OrgConductor.Outcome> {
    const id = key(input.projectDir, input.runID)
    const existing = flights.get(id)
    if (existing) return existing
    const flight = OrgConductor.drive(input.runID, {
      projectDir: input.projectDir,
      org: input.org,
      runnerDeps: { costOf: input.runtime.costOf },
      spawnChief: input.runtime.spawnChief,
      evaluate: input.runtime.evaluate,
      now: Date.now,
      emit: () => {},
      lock: input.lock,
    }).finally(() => flights.delete(id))
    flights.set(id, flight)
    return flight
  }
}
