import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
import { Bus } from "../../src/bus"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Config } from "../../src/config/config"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../../src/kilocode/instance"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Provider } from "../../src/provider/provider"
import { TaskTool, type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const state = path.join(Global.Path.state, "model.json")

afterEach(async () => {
  process.env.KILO_CLIENT = "cli"
  await fs.rm(state, { force: true }).catch(() => undefined)
  await disposeAllInstances()
})

beforeAll(async () => {
  process.env.KILO_CLIENT = "cli"
  await fs.rm(state, { force: true }).catch(() => undefined)
})

const parent = {
  providerID: ProviderID.make("parent-provider"),
  modelID: ModelID.make("parent-model"),
}

const saved = {
  providerID: ProviderID.make("saved-provider"),
  modelID: ModelID.make("saved-model"),
}

const cfg = {
  providerID: ProviderID.make("config-provider"),
  modelID: ModelID.make("config-model"),
}

const inherited = "thorough"
const overrideVariant = "full"
const savedVariant = "fast"
const cfgVariant = "balanced"
const sub = {
  providerID: ProviderID.make("sub-provider"),
  modelID: ModelID.make("sub-model"),
}
const subVariant = "deep"

function custom(
  id: string,
  model: string,
  variants: string[] = [],
  opts?: { cost?: { input: number; output: number }; tool_call?: boolean },
) {
  return {
    name: id,
    id,
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: {
      [model]: {
        id: model,
        name: model,
        attachment: false,
        reasoning: variants.length > 0,
        temperature: false,
        tool_call: opts?.tool_call ?? true,
        release_date: "2025-01-01",
        limit: { context: 100_000, output: 10_000 },
        cost: opts?.cost ?? { input: 0, output: 0 },
        options: {},
        variants: Object.fromEntries(variants.map((variant) => [variant, {}])),
      },
    },
    options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
  }
}

// kilocode_change start - W1.5: cheap/pricey/toolless catalog entries for cost-aware fallback ranking tests
const cheapFallback = {
  providerID: ProviderID.make("cheap-fallback-provider"),
  modelID: ModelID.make("cheap-fallback-model"),
}
const priceyFallback = {
  providerID: ProviderID.make("pricey-fallback-provider"),
  modelID: ModelID.make("pricey-fallback-model"),
}
const toollessFallback = {
  providerID: ProviderID.make("toolless-fallback-provider"),
  modelID: ModelID.make("toolless-fallback-model"),
}
// kilocode_change end

const catalog = {
  provider: {
    "parent-provider": custom("parent-provider", "parent-model", [inherited, overrideVariant], {
      cost: { input: 10, output: 20 }, // kilocode_change - W1.5: parent priced above the cheap fallback so ranking is provably cheaper
    }),
    // kilocode_change - W1.5: priced (was 0/0) so it doesn't silently out-rank cheap-fallback-provider
    // in the ranking tests below; none of the non-W1.5 tests assert on cost, only on identity.
    "saved-provider": custom("saved-provider", "saved-model", [savedVariant, overrideVariant], {
      cost: { input: 6, output: 9 },
    }),
    "config-provider": custom("config-provider", "config-model", [cfgVariant, overrideVariant], {
      cost: { input: 7, output: 9 },
    }),
    "sub-provider": custom("sub-provider", "sub-model", [subVariant, overrideVariant], {
      cost: { input: 8, output: 9 },
    }),
    // kilocode_change start - W1.5: extra catalog entries only used by the cost-aware fallback tests
    "cheap-fallback-provider": custom("cheap-fallback-provider", "cheap-fallback-model", [], {
      cost: { input: 1, output: 2 },
    }),
    "pricey-fallback-provider": custom("pricey-fallback-provider", "pricey-fallback-model", [], {
      cost: { input: 5, output: 8 },
    }),
    "toolless-fallback-provider": custom("toolless-fallback-provider", "toolless-fallback-model", [], {
      cost: { input: 0.01, output: 0.01 },
      tool_call: false,
    }),
    // kilocode_change end
  },
  // kilocode_change - W1.5: "kilo" auto-connects anonymously with free-tier models regardless of
  // API keys (src/kilocode/provider/provider.ts kiloCustomLoaders.kilo `autoload: models.length > 0`).
  // That's real, correct production behavior for the cost ranker (a genuine $0 catalog member),
  // but it makes catalog-ranking test outcomes nondeterministic against the shared fixture
  // catalog. Disable it here so these tests assert against the closed, hand-built catalog above.
  disabled_providers: ["kilo"],
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    RuntimeFlags.layer(),
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    Provider.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const seed = Effect.fn("TaskToolModelTest.seed")(function* (title = "Parent", variant?: string) {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: parent,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: parent.modelID,
    providerID: parent.providerID,
    variant,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  const prompt = (input: SessionPrompt.PromptInput) =>
    Effect.sync(() => {
      opts?.onPrompt?.(input)
      return reply(input, opts?.text ?? "done")
    })
  return {
    cancel: () => Effect.void,
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt,
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? parent.modelID,
      providerID: input.model?.providerID ?? parent.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

function writeState(input: unknown) {
  return Effect.promise(async () => {
    await fs.mkdir(Global.Path.state, { recursive: true })
    await fs.writeFile(state, JSON.stringify(input))
  })
}

function run(input: {
  agent: "pinned" | "worker"
  state?: unknown
  client?: string
  variant?: string
  config?: Pick<Config.Info, "subagent_model" | "subagent_variant" | "subagent_variant_overrides">
  catalogOverride?: {
    provider: Record<string, ReturnType<typeof custom>>
    disabled_providers?: string[]
  } // kilocode_change - W1.5: swap the connected-provider catalog for depth/ranking tests
}) {
  return provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        process.env.KILO_CLIENT = input.client ?? "cli"
        if (input.state) yield* writeState(input.state)

        const { chat, assistant } = yield* seed(input.agent, input.variant)
        const tool = yield* TaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({ onPrompt: (value) => (seen = value) })

        const result = yield* def.execute(
          {
            description: `run ${input.agent}`,
            prompt: "inspect resolution",
            subagent_type: input.agent,
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            extra: { promptOps, bypassAgentCheck: true },
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )

        return {
          prompt: seen?.model,
          variant: seen?.variant,
          model: result.metadata.model,
          metadataVariant: result.metadata.variant,
        }
      }),
    {
      config: {
        ...(input.catalogOverride ?? catalog), // kilocode_change - W1.5: allow tests to control the connected catalog
        ...input.config,
        agent: {
          worker: { mode: "subagent" },
          pinned: { mode: "subagent", model: "config-provider/config-model", variant: cfgVariant },
        },
      },
    },
  )
}

describe("tool.task model resolution", () => {
  it.live("saved model beats agent config for pinned", () =>
    run({
      agent: "pinned",
      state: { model: { pinned: saved }, variant: { "saved-provider/saved-model": savedVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(saved)
          expect(result.variant).toEqual(savedVariant)
          expect(result.model).toMatchObject({ ...saved, variant: savedVariant })
          expect(result.metadataVariant).toEqual(savedVariant)
        }),
      ),
    ),
  )

  it.live("saved model beats parent for worker", () =>
    run({
      agent: "worker",
      state: { model: { worker: saved }, variant: { "saved-provider/saved-model": savedVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(saved)
          expect(result.variant).toEqual(savedVariant)
          expect(result.model).toMatchObject({ ...saved, variant: savedVariant })
          expect(result.metadataVariant).toEqual(savedVariant)
        }),
      ),
    ),
  )

  it.live("saved model without variant leaves variant undefined", () =>
    run({
      agent: "worker",
      variant: inherited,
      state: { model: { worker: saved } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(saved)
          expect(result.variant).toBeUndefined()
          expect(result.model).toEqual(saved)
          expect(result.metadataVariant).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("unrelated saved variant key ignored", () =>
    run({
      agent: "worker",
      state: { model: { worker: saved }, variant: { "other-provider/other-model": savedVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(saved)
          expect(result.variant).toBeUndefined()
          expect(result.model).toEqual(saved)
          expect(result.metadataVariant).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("missing saved entry falls back to agent config for pinned", () =>
    run({
      agent: "pinned",
      state: { model: { worker: saved } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(cfg)
          expect(result.variant).toEqual(cfgVariant)
          expect(result.model).toEqual(cfg)
          expect(result.metadataVariant).toEqual(cfgVariant)
        }),
      ),
    ),
  )

  it.live("configured subagent default model and variant apply to task workers", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_model: "sub-provider/sub-model", subagent_variant: subVariant },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(sub)
          expect(result.variant).toEqual(subVariant)
          expect(result.model).toEqual(sub)
          expect(result.metadataVariant).toEqual(subVariant)
        }),
      ),
    ),
  )

  it.live("per-agent task model remains above the configured subagent default", () =>
    run({
      agent: "pinned",
      variant: inherited,
      config: { subagent_model: "sub-provider/sub-model", subagent_variant: subVariant },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(cfg)
          expect(result.variant).toEqual(cfgVariant)
          expect(result.model).toEqual(cfg)
          expect(result.metadataVariant).toEqual(cfgVariant)
        }),
      ),
    ),
  )

  it.live("model-specific override replaces an inherited parent variant", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_variant_overrides: { "parent-provider/parent-model": overrideVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(parent)
          expect(result.variant).toEqual(overrideVariant)
          expect(result.model).toEqual(parent)
          expect(result.metadataVariant).toEqual(overrideVariant)
        }),
      ),
    ),
  )

  it.live("model-specific override applies to a custom subagent model and variant", () =>
    run({
      agent: "pinned",
      variant: inherited,
      config: { subagent_variant_overrides: { "config-provider/config-model": overrideVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(cfg)
          expect(result.variant).toEqual(overrideVariant)
          expect(result.model).toEqual(cfg)
          expect(result.metadataVariant).toEqual(overrideVariant)
        }),
      ),
    ),
  )

  it.live("model-specific override follows a saved custom subagent model", () =>
    run({
      agent: "worker",
      state: { model: { worker: saved }, variant: { "saved-provider/saved-model": savedVariant } },
      config: { subagent_variant_overrides: { "saved-provider/saved-model": overrideVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(saved)
          expect(result.variant).toEqual(overrideVariant)
          expect(result.model).toMatchObject({ ...saved, variant: overrideVariant })
          expect(result.metadataVariant).toEqual(overrideVariant)
        }),
      ),
    ),
  )

  it.live("stale model-specific override preserves the resolved variant", () =>
    run({
      agent: "pinned",
      variant: inherited,
      config: { subagent_variant_overrides: { "config-provider/config-model": "gone" } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(cfg)
          expect(result.variant).toEqual(cfgVariant)
          expect(result.model).toEqual(cfg)
          expect(result.metadataVariant).toEqual(cfgVariant)
        }),
      ),
    ),
  )

  // kilocode_change start - W1.5: unavailable configured subagent model now ranks the live
  // catalog by $/token instead of blindly jumping to the parent model. Provider pricing
  // (Model.cost.input/output) and the connected catalog (Provider.list()) are both reachable
  // from resolveModel's Effect context — see cheap-fallback-provider (1/2) vs parent-provider
  // (10/20) in the shared `catalog` above. This REPLACES the old blunt-parent-fallback
  // assertion for this exact scenario; the deliberate-pin invariant (a HEALTHY configured
  // model is never re-ranked) is covered separately below.
  it.live("unavailable configured subagent model ranks the catalog and picks the cheapest capable model", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_model: "missing-provider/missing-model", subagent_variant: subVariant },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(cheapFallback)
          expect(result.model).toEqual(cheapFallback)
          // provably cheaper than the parent model it replaces (parent: input 10/output 20)
          expect(result.prompt).not.toEqual(parent)
        }),
      ),
    ),
  )

  it.live("unavailable configured subagent model skips a cheaper but toolcall-incapable catalog entry", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_model: "missing-provider/missing-model", subagent_variant: subVariant },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          // toolless-fallback-provider (0.01/0.01) is cheaper than cheap-fallback-provider (1/2)
          // but lacks toolcall capability, so it must not be selected for a task subagent.
          expect(result.prompt).not.toEqual(toollessFallback)
          expect(result.prompt).toEqual(cheapFallback)
        }),
      ),
    ),
  )

  it.live("unavailable configured subagent model falls back to the parent model override when no cheaper catalog entry exists", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: {
        subagent_model: "missing-provider/missing-model",
        subagent_variant: subVariant,
        subagent_variant_overrides: { "parent-provider/parent-model": overrideVariant },
      },
      // Deliberately a closed catalog with ONLY the parent model present (no cheaper capable
      // alternative anywhere) so this proves the tail correctly still lands on parent when
      // ranking has nothing better to offer — not because ranking didn't run.
      catalogOverride: {
        provider: {
          "parent-provider": custom("parent-provider", "parent-model", [inherited, overrideVariant], {
            cost: { input: 10, output: 20 },
          }),
        },
        disabled_providers: ["kilo"],
      },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(parent)
          expect(result.variant).toEqual(overrideVariant)
          expect(result.model).toEqual(parent)
          expect(result.metadataVariant).toEqual(overrideVariant)
        }),
      ),
    ),
  )

  it.live("fallback chain traverses depth > 2: unavailable subagent_model AND unavailable cheapest catalog entry falls through to the next cheapest", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_model: "missing-provider/missing-model", subagent_variant: subVariant },
      catalogOverride: {
        provider: {
          "parent-provider": custom("parent-provider", "parent-model", [inherited, overrideVariant], {
            cost: { input: 10, output: 20 },
          }),
          // cheap-fallback-provider deliberately omitted to simulate it going unavailable
          // after being the top-ranked candidate, forcing the resolver past level 3 (saved,
          // agent.model/subagent_model, first-ranked-cheapest) to a 4th level.
          "pricey-fallback-provider": custom("pricey-fallback-provider", "pricey-fallback-model", [], {
            cost: { input: 5, output: 8 },
          }),
        },
        disabled_providers: ["kilo"],
      },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(priceyFallback)
          expect(result.model).toEqual(priceyFallback)
        }),
      ),
    ),
  )

  it.live("cost ties broken deterministically by lexicographic model key regardless of discovery order", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_model: "missing-provider/missing-model", subagent_variant: subVariant },
      // Two equal-priced (1/2) capable candidates. `zzz` is inserted FIRST so object-iteration
      // order alone would surface it — the stable tiebreak in rank() must instead resolve to the
      // lexicographically-first key ("aaa-tie-provider/tie-model"), proving the pick is
      // reproducible independent of provider-discovery order.
      catalogOverride: {
        provider: {
          "zzz-tie-provider": custom("zzz-tie-provider", "tie-model", [], { cost: { input: 1, output: 2 } }),
          "aaa-tie-provider": custom("aaa-tie-provider", "tie-model", [], { cost: { input: 1, output: 2 } }),
          "parent-provider": custom("parent-provider", "parent-model", [inherited, overrideVariant], {
            cost: { input: 10, output: 20 },
          }),
        },
        disabled_providers: ["kilo"],
      },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual({
            providerID: ProviderID.make("aaa-tie-provider"),
            modelID: ModelID.make("tie-model"),
          })
        }),
      ),
    ),
  )
  // kilocode_change end

  it.live("deliberate pin invariant: healthy configured subagent model is used unchanged, never re-ranked by cost", () =>
    run({
      agent: "worker",
      variant: inherited,
      config: { subagent_model: "sub-provider/sub-model", subagent_variant: subVariant },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          // sub-provider/sub-model is priced input:8/output:9 in the shared catalog — NOT the
          // cheapest (cheap-fallback-provider at 1/2 is cheaper). It is selected purely because
          // it is HEALTHY/available and therefore returned pre-ranking, unchanged. That is the
          // whole deliberate-pin invariant: cost-awareness only applies to the FALLBACK
          // selection, never to a working configured pin — a cheaper catalog model must NOT
          // displace it.
          expect(result.prompt).toEqual(sub)
          expect(result.model).toEqual(sub)
        }),
      ),
    ),
  )

  it.live("stale configured subagent variant is ignored without dropping its model", () =>
    run({
      agent: "worker",
      config: { subagent_model: "sub-provider/sub-model", subagent_variant: "gone" },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(sub)
          expect(result.variant).toBeUndefined()
          expect(result.model).toEqual(sub)
          expect(result.metadataVariant).toBeUndefined()
        }),
      ),
    ),
  )

  it.live("no file and no agent config inherits the parent model and variant", () =>
    run({
      agent: "worker",
      variant: inherited,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(parent)
          expect(result.variant).toEqual(inherited)
          expect(result.model).toEqual(parent)
          expect(result.metadataVariant).toEqual(inherited)
        }),
      ),
    ),
  )

  it.live("malformed file ignored and falls back to agent config for pinned", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          process.env.KILO_CLIENT = "cli"
          yield* Effect.promise(async () => {
            await fs.mkdir(Global.Path.state, { recursive: true })
            await fs.writeFile(state, "{bad json")
          })

          const { chat, assistant } = yield* seed("pinned")
          const tool = yield* TaskTool
          const def = yield* tool.init()
          let seen: SessionPrompt.PromptInput | undefined
          const promptOps = stubOps({ onPrompt: (value) => (seen = value) })

          const result = yield* def.execute(
            {
              description: "run pinned",
              prompt: "inspect resolution",
              subagent_type: "pinned",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { promptOps, bypassAgentCheck: true },
              messages: [],
              metadata: () => Effect.void,
              ask: () => Effect.void,
            },
          )

          expect(seen?.model).toEqual(cfg)
          expect(seen?.variant).toEqual(cfgVariant)
          expect(result.metadata.model).toEqual(cfg)
          expect(result.metadata.variant).toEqual(cfgVariant)
        }),
      {
        config: {
          ...catalog,
          agent: {
            worker: { mode: "subagent" },
            pinned: { mode: "subagent", model: "config-provider/config-model", variant: cfgVariant },
          },
        },
      },
    ),
  )

  it.live("non-CLI client gate ignores saved worker model and uses parent", () =>
    run({
      agent: "worker",
      client: "vscode",
      state: { model: { worker: saved }, variant: { "saved-provider/saved-model": savedVariant } },
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.prompt).toEqual(parent)
          expect(result.variant).toBeUndefined()
          expect(result.model).toEqual(parent)
          expect(result.metadataVariant).toBeUndefined()
        }),
      ),
    ),
  )
})
