// kilocode_change - new file
//
// EPIC 5 Task 5.4 — exit test / review-prep for provider & model authoring.
//
// EPIC 5 gave the CLI local/openai-compatible ("BYOK") provider authoring:
//   - 5.2 `@/kilocode/provider/local-provider.ts` (`addLocalProviders`) — a GLOBAL auth.json
//     entry carrying `{ baseURL, preset }` resolves into a live openai-compatible provider,
//     with models discovered via the model-cache `/models` fetch.
//   - 5.3 `@/kilocode/provider/local-model-validation.ts` — a discovered model with unknown
//     capabilities is flagged "unverified", surfaces a visible warning, and (via the
//     pre-existing `session/overflow.ts` convention) keeps automatic compaction off.
//
// This file proves the FOUR EPIC-5-plan §5.4 acceptance criteria hold, end to end, by
// reusing every harness the individual EPIC 5 unit-test files already built rather than
// inventing new infra or mocking out the functions under test:
//   (a) local provider resolves         — `addLocalProviders` (5.2) + the mocked-`/models`
//                                          `cacheLayer` harness from `local-provider.test.ts`,
//                                          fed through the REAL `Provider.fromModelsDevProvider`
//                                          transform `Provider.list()` itself applies
//                                          (`@/provider/provider.ts`, wired via `addLocalProviders`
//                                          in `@/provider/models.ts`).
//   (b) agent-dedicatable               — the SAME discovered providerID/modelID from (a), driven
//                                          through the real `Agent.Service.get()` config path
//                                          (`item.model = Provider.parseModel(value.model)` in
//                                          `@/agent/agent.ts`), mirroring `agent.test.ts`'s
//                                          "custom agent from config creates new agent".
//   (c) unverified model -> warning + compaction off — the SAME `fromModelsDevProvider`-resolved
//                                          `Provider.Model` for a discovered id with no known
//                                          capabilities, run through `modelCapabilityStatus` /
//                                          `isModelVerified` / `modelWarning` (5.3) and
//                                          `session/overflow.ts`'s `isOverflow` (untouched by
//                                          EPIC 5 — this only asserts its pre-existing behavior).
//   (d) {env:} invariant regression guard — a thin re-assertion of the exact untrusted-config
//                                          setup already covered by
//                                          `test/kilocode/config/variable.test.ts`'s "rejects
//                                          environment references in untrusted (project) config",
//                                          proving EPIC 5's global-auth writes did not weaken the
//                                          project-config security boundary documented in
//                                          `@/config/variable.ts`.

import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import type { Provider as ModelsDevProvider } from "@opencode-ai/core/models-dev"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { ConfigVariable } from "@/config/variable"
import { InvalidError } from "@/config/error"
import { ModelCache } from "@/provider/model-cache"
import { Provider as RuntimeProvider } from "@/provider/provider"
import type { MessageV2 } from "@/session/message-v2"
import { isOverflow } from "@/session/overflow"
import { addLocalProviders } from "@/kilocode/provider/local-provider"
import { isModelVerified, modelCapabilityStatus, modelWarning } from "@/kilocode/provider/local-model-validation"
import { disposeAllInstances } from "../../fixture/fixture"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

// --- shared harness for (a)/(c): auth-seeded local provider + mocked /models -----------------
// Copied verbatim from `local-provider.test.ts` (the 5.2 spec) per the task brief: "reuse that
// harness, do not invent a new one."

const node = CrossSpawnSpawner.defaultLayer
const itLocal = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

function cacheLayer(response: unknown) {
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response))),
  )
  return Layer.fresh(ModelCache.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(TestConfig.layer()),
    Layer.provide(Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined) })),
    Layer.provide(ModelCache.kiloModelsLayer),
  )
}

describe("(a) local provider resolves", () => {
  itLocal.live(
    "an auth-seeded {baseURL,preset} entry + a mocked /models response resolves via addLocalProviders, and Provider.fromModelsDevProvider (the exact transform Provider.list() applies) turns it into a valid openai-compatible runtime provider with >=1 model",
    () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("epic5-exit-ollama", {
          type: "api",
          key: "local",
          metadata: { baseURL: "http://localhost:11434/v1", preset: "ollama" },
        })

        const cache = yield* ModelCache.Service.pipe(Effect.provide(cacheLayer({ data: [{ id: "epic5-model" }] })))

        const providers: Record<string, ModelsDevProvider> = {}
        yield* addLocalProviders(providers, auth, cache)

        const discovered = providers["epic5-exit-ollama"]
        expect(discovered).toBeDefined()
        expect(discovered.npm).toBe("@ai-sdk/openai-compatible")
        expect(discovered.api).toBe("http://localhost:11434/v1")
        expect(Object.keys(discovered.models).length).toBeGreaterThanOrEqual(1)
        expect(discovered.models["epic5-model"]).toBeDefined()

        // `Provider.list()` builds its catalog with
        // `catalog = mapValues(modelsDev, fromModelsDevProvider)` (`@/provider/provider.ts`),
        // where `modelsDev` comes from `ModelsDev.Service.get()` (`@/provider/models.ts`), which
        // calls `addLocalProviders` exactly as above. Running the discovered provider through
        // the same real transform proves it resolves into the exact runtime shape
        // `Provider.list()` / `northstar models` would surface it as.
        const resolved = RuntimeProvider.fromModelsDevProvider(discovered)
        expect(String(resolved.id)).toBe("epic5-exit-ollama")
        const model = resolved.models["epic5-model"]
        expect(model).toBeDefined()
        expect(String(model.providerID)).toBe("epic5-exit-ollama")
        expect(String(model.id)).toBe("epic5-model")
        expect(model.api.npm).toBe("@ai-sdk/openai-compatible")
      }),
  )
})

describe("(b) agent-dedicatable", () => {
  // The exact providerID/modelID proven to resolve in (a) — reused here to show it is usable as
  // an agent's `model:` config value, not just a hypothetical string.
  const LOCAL_MODEL_STRING = "epic5-exit-ollama/epic5-model"

  test("Provider.parseModel — the same function agent.ts uses for item.model — splits providerID/modelID correctly", () => {
    const parsed = RuntimeProvider.parseModel(LOCAL_MODEL_STRING)
    expect(String(parsed.providerID)).toBe("epic5-exit-ollama")
    expect(String(parsed.modelID)).toBe("epic5-model")
  })

  const itAgent = testEffect(Agent.defaultLayer)

  itAgent.instance(
    "an agent config `model: 'epic5-exit-ollama/epic5-model'` resolves via the real Agent.Service.get() config path (item.model = Provider.parseModel(value.model) in @/agent/agent.ts)",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service.use((svc) => svc.get("epic5_local_agent"))
        expect(agent).toBeDefined()
        expect(String(agent?.model?.providerID)).toBe("epic5-exit-ollama")
        expect(String(agent?.model?.modelID)).toBe("epic5-model")
      }),
    {
      config: {
        agent: {
          epic5_local_agent: { model: LOCAL_MODEL_STRING },
        },
      },
    },
  )
})

describe("(c) unverified model -> warning + compaction stays off", () => {
  function cfg(compaction?: Config.Info["compaction"]): Config.Info {
    const config = Schema.decodeUnknownSync(Config.Info)({ compaction })
    return {
      ...config,
      skills: config.skills && {
        paths: config.skills.paths && [...config.skills.paths],
        urls: config.skills.urls && [...config.skills.urls],
      },
    }
  }

  function tokens(count: number): MessageV2.Assistant["tokens"] {
    return { input: count, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  }

  itLocal.live(
    "a local model discovered with no known capabilities resolves unverified, warns, and keeps compaction off — even under a huge token count",
    () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("epic5-exit-unverified", {
          type: "api",
          key: "local",
          metadata: { baseURL: "http://localhost:1234/v1", preset: "openai-compatible" },
        })

        // No pre-existing catalog entry for "epic5-exit-unverified" -> `withKnownCapabilities`
        // has nothing to borrow from, so `aperture()`'s safe default applies
        // (tool_call:false, limit.context/output:0) — the exact "unverified" shape 5.3 introduced.
        const cache = yield* ModelCache.Service.pipe(
          Effect.provide(cacheLayer({ data: [{ id: "epic5-mystery-model" }] })),
        )

        const providers: Record<string, ModelsDevProvider> = {}
        yield* addLocalProviders(providers, auth, cache)

        const discovered = providers["epic5-exit-unverified"]
        expect(discovered.models["epic5-mystery-model"]).toBeDefined()
        expect(discovered.models["epic5-mystery-model"].tool_call).toBe(false)
        expect(discovered.models["epic5-mystery-model"].limit).toEqual({ context: 0, output: 0 })

        // Same real transform as (a) — this is a genuine `Provider.Model`, not a hand-rolled fixture.
        const resolvedModel = RuntimeProvider.fromModelsDevProvider(discovered).models["epic5-mystery-model"]
        expect(resolvedModel).toBeDefined()

        expect(modelCapabilityStatus(resolvedModel)).toBe("unverified")
        expect(isModelVerified(resolvedModel)).toBe(false)

        const warning = modelWarning(resolvedModel)
        expect(warning).toBeDefined()
        expect(warning).toContain("context")
        expect(warning).toContain("tool")

        // session/overflow.ts (untouched by EPIC 5): limit.context === 0 -> no overflow, ever —
        // compaction stays off regardless of how many tokens have accumulated.
        expect(
          isOverflow({ cfg: cfg({ threshold_percent: 1 }), model: resolvedModel, tokens: tokens(999_999_999) }),
        ).toBe(false)
      }),
  )
})

describe("(d) {env:} invariant regression guard", () => {
  // Mirrors `test/kilocode/config/variable.test.ts`'s "rejects environment references in
  // untrusted (project) config" verbatim — a thin re-assertion, not a new fixture — proving
  // EPIC 5's global-auth writes (local providers are ALWAYS written to the global auth store,
  // never project config — see `@/kilocode/provider/local-provider.ts`'s module docstring) did
  // not weaken this pre-existing project-config security boundary.
  const source = { type: "virtual" as const, source: "test", dir: process.cwd() }

  test("untrusted (project) config still rejects {env:...} references", async () => {
    await expect(
      ConfigVariable.substitute({ ...source, text: "value={env:SAFE_VALUE}", env: { SAFE_VALUE: "allowed" } }),
    ).rejects.toBeInstanceOf(InvalidError)
  })
})
