// kilocode_change - SP1 adapter from Effect session services to the promise-based OrgDriver runtime
import { Effect } from "effect"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import type * as SessionPrompt from "@/session/prompt"
import type { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { OrgDriver } from "./driver"

type PromptPort = {
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"], unknown>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts, unknown>
}

export function effectSessionBridge(input: {
  sessions: Session.Interface
  prompts: PromptPort
  provider?: Provider.Interface
}): OrgDriver.SessionBridge {
  return {
    get: async (sessionID) => {
      const info = await Effect.runPromise(
        input.sessions.get(SessionID.make(sessionID)).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
      )
      return info
        ? {
            id: info.id,
            parentID: info.parentID,
            cost: info.cost ?? 0,
            model: info.model ? { providerID: info.model.providerID, modelID: info.model.id } : undefined,
          }
        : undefined
    },
    create: async (request) => {
      const info = await Effect.runPromise(
        input.sessions.create({
          parentID: SessionID.make(request.parentID),
          title: request.title,
          agent: request.agent,
          model: request.model
            ? { providerID: ProviderID.make(request.model.providerID), id: ModelID.make(request.model.modelID) }
            : undefined,
          permission: request.permission,
        }),
      )
      return {
        id: info.id,
        parentID: info.parentID,
        cost: info.cost ?? 0,
        model: info.model ? { providerID: info.model.providerID, modelID: info.model.id } : undefined,
      }
    },
    prompt: async (request) => {
      const parts = await Effect.runPromise(input.prompts.resolvePromptParts(request.text))
      const message = await Effect.runPromise(
        input.prompts.prompt({
          sessionID: SessionID.make(request.sessionID),
          agent: request.agent,
          model: request.model
            ? {
                providerID: ProviderID.make(request.model.providerID),
                modelID: ModelID.make(request.model.modelID),
              }
            : undefined,
          tools: request.tools,
          parts,
        }),
      )
      return message.parts.findLast((part) => part.type === "text")?.text ?? ""
    },
    messages: async (sessionID) => {
      const messages = await Effect.runPromise(input.sessions.messages({ sessionID: SessionID.make(sessionID) }))
      return messages.map((message) => ({
        parts: message.parts.map((part) => ({
          type: part.type,
          tool: part.type === "tool" ? part.tool : undefined,
        })),
      }))
    },
    smallModel: async (providerID) => {
      if (!input.provider) return undefined
      const model = await Effect.runPromise(input.provider.getSmallModel(ProviderID.make(providerID)))
      return model ? { providerID: model.providerID, modelID: model.id } : undefined
    },
  }
}
