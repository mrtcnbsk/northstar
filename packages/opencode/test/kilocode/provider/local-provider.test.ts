// kilocode_change - new file
//
// TDD RED->GREEN spec for the generic local/openai-compatible provider (EPIC 5 Task 5.2).
//
// A "local provider" is a GLOBAL auth.json entry keyed by an arbitrary providerID (e.g.
// "ollama") carrying `{ baseURL, preset }` metadata. `addLocalProviders` scans the auth
// store for such entries and registers each as an openai-compatible provider (models
// discovered via the model-cache openai-compatible `/models` fetch), mirroring how
// `addApertis` injects the Apertis provider in `src/provider/models.ts`.

import path from "node:path"
import fs from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import type { Provider } from "@opencode-ai/core/models-dev"
import { Auth } from "@/auth"
import { ModelCache } from "@/provider/model-cache"
import { addLocalProviders, LOCAL_PRESETS, localProviderModelWarning } from "@/kilocode/provider/local-provider"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"

const node = CrossSpawnSpawner.defaultLayer
const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

/** Self-contained ModelCache layer with a stubbed HttpClient standing in for a real /models endpoint. */
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

describe("LOCAL_PRESETS", () => {
  test("carries the expected default base URLs per preset", () => {
    expect(LOCAL_PRESETS.ollama).toBe("http://localhost:11434/v1")
    expect(LOCAL_PRESETS.lmstudio).toBe("http://localhost:1234/v1")
    expect(LOCAL_PRESETS["openai-compatible"]).toBeUndefined()
  })
})

describe("addLocalProviders", () => {
  it.live("resolves an auth-seeded local provider with discovered models", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("ollama", {
        type: "api",
        key: "local",
        metadata: { baseURL: "http://localhost:11434/v1", preset: "ollama" },
      })

      const cache = yield* ModelCache.Service.pipe(Effect.provide(cacheLayer({ data: [{ id: "llama3.1" }] })))

      const providers: Record<string, Provider> = {}
      yield* addLocalProviders(providers, auth, cache)

      const provider = providers["ollama"]
      expect(provider).toBeDefined()
      expect(provider.npm).toBe("@ai-sdk/openai-compatible")
      expect(provider.api).toBe("http://localhost:11434/v1")
      expect(Object.keys(provider.models).length).toBeGreaterThanOrEqual(1)
    }),
  )

  it.live("never overrides kilo/apertis — resolved earlier in the same get() call via their own flow", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("apertis", {
        type: "api",
        key: "local",
        metadata: { baseURL: "http://localhost:9/v1", preset: "openai-compatible" },
      })

      const cache = yield* ModelCache.Service.pipe(Effect.provide(cacheLayer({ data: [{ id: "should-not-appear" }] })))

      const existing: Provider = {
        id: "apertis",
        name: "Apertis",
        env: ["APERTIS_API_KEY"],
        api: "https://api.apertis.ai/v1",
        npm: "@ai-sdk/openai-compatible",
        models: {},
      }
      const providers: Record<string, Provider> = { apertis: existing }
      yield* addLocalProviders(providers, auth, cache)

      expect(providers["apertis"]).toBe(existing)
    }),
  )

  it.live("overrides a base-catalog provider that shares a preset id (e.g. lmstudio) with the user's live endpoint", () =>
    Effect.gen(function* () {
      // models.dev ships a static "lmstudio" catalog entry (fixed baseURL, a handful of
      // known models). A user who explicitly walks through "Add a local provider" for the
      // LM Studio preset wants THEIR live endpoint + live model list to win.
      const auth = yield* Auth.Service
      yield* auth.set("lmstudio", {
        type: "api",
        key: "local",
        metadata: { baseURL: "http://localhost:1234/v1", preset: "lmstudio" },
      })

      const cache = yield* ModelCache.Service.pipe(
        Effect.provide(cacheLayer({ data: [{ id: "qwen3-coder-30b" }] })),
      )

      const staticCatalogStub: Provider = {
        id: "lmstudio",
        name: "LMStudio",
        env: ["LMSTUDIO_API_KEY"],
        api: "http://127.0.0.1:1234/v1",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "openai/gpt-oss-20b": {
            id: "openai/gpt-oss-20b",
            name: "GPT OSS 20B",
            release_date: "",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 131072, output: 32768 },
          },
        },
      }
      const providers: Record<string, Provider> = { lmstudio: staticCatalogStub }
      yield* addLocalProviders(providers, auth, cache)

      const provider = providers["lmstudio"]
      expect(provider).not.toBe(staticCatalogStub)
      expect(provider.api).toBe("http://localhost:1234/v1")
      expect(provider.models["qwen3-coder-30b"]).toBeDefined()
      expect(provider.models["openai/gpt-oss-20b"]).toBeUndefined()
    }),
  )

  it.live(
    "preserves the models.dev catalog's real capabilities for a discovered id it already knows (EPIC 5 Task 5.3)",
    () =>
      Effect.gen(function* () {
        // The live `/models` fetch resolves through `aperture()`, which — since Task 5.3 —
        // marks a model UNVERIFIED (tool_call:false, limit.context:0) when the openai-compatible
        // response carries no capability metadata. But models.dev's static "lmstudio" catalog
        // entry DOES know real capabilities for "openai/gpt-oss-20b" — that catalog data must
        // win so a verified model is never flagged by `@/kilocode/provider/local-model-validation.ts`.
        const auth = yield* Auth.Service
        yield* auth.set("lmstudio", {
          type: "api",
          key: "local",
          metadata: { baseURL: "http://localhost:1234/v1", preset: "lmstudio" },
        })

        const cache = yield* ModelCache.Service.pipe(
          Effect.provide(cacheLayer({ data: [{ id: "openai/gpt-oss-20b" }] })),
        )

        const staticCatalogStub: Provider = {
          id: "lmstudio",
          name: "LMStudio",
          env: ["LMSTUDIO_API_KEY"],
          api: "http://127.0.0.1:1234/v1",
          npm: "@ai-sdk/openai-compatible",
          models: {
            "openai/gpt-oss-20b": {
              id: "openai/gpt-oss-20b",
              name: "GPT OSS 20B",
              release_date: "",
              attachment: false,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: { context: 131072, output: 32768 },
            },
          },
        }
        const providers: Record<string, Provider> = { lmstudio: staticCatalogStub }
        yield* addLocalProviders(providers, auth, cache)

        const model = providers["lmstudio"].models["openai/gpt-oss-20b"]
        expect(model).toBeDefined()
        expect(model.tool_call).toBe(true)
        expect(model.limit).toEqual({ context: 131072, output: 32768 })
      }),
  )

  it.live("does not invent capabilities for a discovered id the catalog does NOT know (stays unverified)", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("lmstudio", {
        type: "api",
        key: "local",
        metadata: { baseURL: "http://localhost:1234/v1", preset: "lmstudio" },
      })

      const cache = yield* ModelCache.Service.pipe(
        Effect.provide(cacheLayer({ data: [{ id: "qwen3-coder-30b" }] })),
      )

      const staticCatalogStub: Provider = {
        id: "lmstudio",
        name: "LMStudio",
        env: ["LMSTUDIO_API_KEY"],
        api: "http://127.0.0.1:1234/v1",
        npm: "@ai-sdk/openai-compatible",
        models: {
          "openai/gpt-oss-20b": {
            id: "openai/gpt-oss-20b",
            name: "GPT OSS 20B",
            release_date: "",
            attachment: false,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 131072, output: 32768 },
          },
        },
      }
      const providers: Record<string, Provider> = { lmstudio: staticCatalogStub }
      yield* addLocalProviders(providers, auth, cache)

      const model = providers["lmstudio"].models["qwen3-coder-30b"]
      expect(model).toBeDefined()
      expect(model.tool_call).toBe(false)
      expect(model.limit).toEqual({ context: 0, output: 0 })
    }),
  )

  it.live("ignores auth entries without both baseURL and preset metadata", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", { type: "api", key: "sk-test" })
      yield* auth.set("partial-metadata-only", {
        type: "api",
        key: "sk-test",
        metadata: { baseURL: "http://localhost:4/v1" }, // no `preset` — not recognized as a local provider
      })

      const cache = yield* ModelCache.Service.pipe(Effect.provide(cacheLayer({ data: [] })))

      const providers: Record<string, Provider> = {}
      yield* addLocalProviders(providers, auth, cache)

      expect(providers["anthropic"]).toBeUndefined()
      expect(providers["partial-metadata-only"]).toBeUndefined()
    }),
  )

  it.live("seeds the credential in the GLOBAL auth.json (0600) — never in project config", () =>
    provideTmpdirInstance(
      (projectDir) =>
        Effect.gen(function* () {
          const projectConfigBefore = yield* Effect.promise(() =>
            fs.readFile(path.join(projectDir, "opencode.json"), "utf8"),
          )

          const auth = yield* Auth.Service
          yield* auth.set("ollama", {
            type: "api",
            key: "local",
            metadata: { baseURL: LOCAL_PRESETS.ollama, preset: "ollama" },
          })

          const globalFile = path.join(Global.Path.data, "auth.json")
          const stat = yield* Effect.promise(() => fs.stat(globalFile))
          expect(stat.mode & 0o777).toBe(0o600)

          const raw = yield* Effect.promise(() => fs.readFile(globalFile, "utf8"))
          const parsed = JSON.parse(raw) as Record<string, unknown>
          expect(parsed["ollama"]).toBeDefined()
          expect((parsed["ollama"] as { metadata?: { baseURL?: string } }).metadata?.baseURL).toBe(
            LOCAL_PRESETS.ollama,
          )

          // The project config on disk must be byte-for-byte unchanged — the credential
          // only ever lands in the global auth store, never in project-scoped config.
          const projectConfigAfter = yield* Effect.promise(() =>
            fs.readFile(path.join(projectDir, "opencode.json"), "utf8"),
          )
          expect(projectConfigAfter).toBe(projectConfigBefore)
          expect(projectConfigAfter).not.toContain("ollama")
        }),
      { config: {} },
    ),
  )
})

describe("localProviderModelWarning", () => {
  test("does not warn on a hosted, tool-capable model with context:0 (false positive being fixed)", () => {
    expect(
      localProviderModelWarning("poe", { limit: { context: 0 }, capabilities: { toolcall: true } }),
    ).toBeUndefined()
  })

  test("does not warn on a hosted provider that is not a local preset", () => {
    expect(
      localProviderModelWarning("vercel", { limit: { context: 0 }, capabilities: { toolcall: false } }),
    ).toBeUndefined()
  })

  test("warns on an ollama model with unverified capabilities", () => {
    const warning = localProviderModelWarning("ollama", {
      limit: { context: 0 },
      capabilities: { toolcall: false },
    })
    expect(warning).toBeTruthy()
    expect(warning).toContain("unverified")
  })

  test("warns on a user-added openai-compatible endpoint with unverified capabilities", () => {
    const warning = localProviderModelWarning("openai-compatible", {
      limit: { context: 0 },
      capabilities: { toolcall: true },
    })
    expect(warning).toBeTruthy()
  })

  test("does not warn on an ollama model with verified capabilities (real context)", () => {
    expect(
      localProviderModelWarning("ollama", { limit: { context: 8192 }, capabilities: { toolcall: true } }),
    ).toBeUndefined()
  })
})
