// kilocode_change - new file
//
// TDD RED->GREEN spec for local-model capability validation (EPIC 5 Task 5.3).
//
// Roadmap 5.3: "if limit.context / tool_call are NOT set (unknown), show a visible warning
// (and compaction turns off)." Compaction-off already exists (`session/overflow.ts`:
// `limit.context === 0` -> no compaction). This spec covers the other two legs:
//   1. `model-cache.ts`'s `aperture()` no longer MASKS an unverified openai-compatible model
//      with a blind `tool_call:true` / `limit.context:128000` default.
//   2. `@/kilocode/provider/local-model-validation.ts` is the single capability check that
//      flags a resolved model as "verified" vs "unverified", bridging `tool_call` (snake/bool,
//      models.dev + config), `toolcall` (camelCase bool, the runtime `Provider.Model`), and
//      Anaconda's 3-state `ToolCapability`.
//   3. That module's `localModelWarning`/`modelWarning` produce a visible warning string for
//      any unverified model.

import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import type { MessageV2 } from "@/session/message-v2"
import { isOverflow } from "@/session/overflow"
import { Auth } from "@/auth"
import { ModelCache } from "@/provider/model-cache"
import {
  capabilityStatus,
  isModelVerified,
  isVerified,
  localModelWarning,
  modelCapabilityStatus,
  modelWarning,
  toToolCapability,
  type ResolvedModel,
} from "@/kilocode/provider/local-model-validation"
import { TestConfig } from "../../fixture/config"
import { testEffect } from "../../lib/effect"

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

function model(opts: { context: number; toolcall: boolean; output?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, output: opts.output ?? 4096 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: opts.toolcall,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as Provider.Model
}

function tokens(count: number): MessageV2.Assistant["tokens"] {
  return { input: count, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

describe("capabilityStatus / toToolCapability — bridging tool_call/toolcall/3-state", () => {
  test("a plain boolean toolcall paired with an unknown (0) context is treated as unknown", () => {
    expect(toToolCapability({ context: 0, toolcall: true })).toBe("unknown")
    expect(toToolCapability({ context: 0, toolcall: false })).toBe("unknown")
  })

  test("a plain boolean toolcall paired with a confirmed context is trusted", () => {
    expect(toToolCapability({ context: 128_000, toolcall: true })).toBe("supported")
    expect(toToolCapability({ context: 128_000, toolcall: false })).toBe("unsupported")
  })

  test("Anaconda's 3-state ToolCapability passes through unchanged", () => {
    expect(toToolCapability({ context: 128_000, toolcall: "unknown" })).toBe("unknown")
    expect(toToolCapability({ context: 128_000, toolcall: "supported" })).toBe("supported")
    expect(toToolCapability({ context: 128_000, toolcall: "unsupported" })).toBe("unsupported")
  })

  test("verified requires both a confirmed context AND confirmed tool-call support", () => {
    expect(capabilityStatus({ context: 0, toolcall: false })).toBe("unverified")
    expect(capabilityStatus({ context: 128_000, toolcall: "unknown" })).toBe("unverified")
    expect(capabilityStatus({ context: 128_000, toolcall: true })).toBe("verified")
    expect(capabilityStatus({ context: 128_000, toolcall: "supported" })).toBe("verified")
    // an explicit, confirmed "unsupported" is still VERIFIED (known, just false) — not flagged
    expect(capabilityStatus({ context: 128_000, toolcall: false })).toBe("verified")
    expect(isVerified({ context: 128_000, toolcall: false })).toBe(true)
  })
})

describe("(a) unverified: no metadata -> flagged, warned, compaction off", () => {
  test("a model discovered with no capability metadata is unverified", () => {
    const mdl = model({ context: 0, toolcall: false })
    expect(modelCapabilityStatus(mdl)).toBe("unverified")
    expect(isModelVerified(mdl)).toBe(false)
  })

  test("a visible warning string is produced", () => {
    const mdl = model({ context: 0, toolcall: false })
    const warning = modelWarning(mdl)
    expect(warning).toBeDefined()
    expect(warning).toContain("context")
    expect(warning).toContain("tool")
  })

  test("context resolves to 0 so overflow.isOverflow reports no overflow (compaction off)", () => {
    const mdl = model({ context: 0, toolcall: false })
    expect(isOverflow({ cfg: cfg({ threshold_percent: 1 }), model: mdl, tokens: tokens(999_999_999) })).toBe(false)
  })
})

describe("(b) verified: real catalog/metadata context + tool_call", () => {
  test("a model with a real context + confirmed tool_call is verified, no warning", () => {
    const mdl = model({ context: 200_000, toolcall: true })
    expect(modelCapabilityStatus(mdl)).toBe("verified")
    expect(modelWarning(mdl)).toBeUndefined()
  })

  test("compaction behaves normally (real limits used, threshold still triggers)", () => {
    const conf = cfg({ threshold_percent: 75 })
    const mdl = model({ context: 200_000, toolcall: true, output: 32_000 })
    expect(isOverflow({ cfg: conf, model: mdl, tokens: tokens(149_999) })).toBe(false)
    expect(isOverflow({ cfg: conf, model: mdl, tokens: tokens(150_000) })).toBe(true)
  })
})

describe("(c) explicit user-config limit.context/tool_call", () => {
  test("an explicit config value (even tool_call:false) is verified, no warning", () => {
    const mdl = model({ context: 32_768, toolcall: false })
    expect(modelCapabilityStatus(mdl)).toBe("verified")
    expect(modelWarning(mdl)).toBeUndefined()
  })
})

describe("ResolvedModel structural type", () => {
  test("accepts a minimal shape without the full Provider.Model", () => {
    const minimal: ResolvedModel = { limit: { context: 0 }, capabilities: { toolcall: false } }
    expect(isModelVerified(minimal)).toBe(false)
  })
})

// --- aperture() masking fix (model-cache.ts) -------------------------------------------

const auth = Layer.mock(Auth.Service)({ get: () => Effect.succeed(undefined) })

function cacheLayer(response: unknown) {
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(response))),
  )
  return Layer.fresh(ModelCache.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provide(TestConfig.layer()),
    Layer.provide(auth),
    Layer.provide(ModelCache.kiloModelsLayer),
  )
}

const it = testEffect(Layer.empty)

describe("aperture() no longer masks unknown capabilities", () => {
  it.live("an openai-compatible model discovered with no metadata resolves to unverified", () =>
    Effect.gen(function* () {
      const models = yield* ModelCache.Service.use((cache) =>
        cache.fetch("apertis", { apiKey: "test-key", baseURL: "https://apertis.test/v1" }),
      ).pipe(Effect.provide(cacheLayer({ data: [{ id: "mystery-model", owned_by: "apertis" }] })))

      const synthesized = models["mystery-model"]
      expect(synthesized).toBeDefined()
      // no blind 128000/true default -- the safe, unverified default instead
      expect(synthesized.limit.context).toBe(0)
      expect(synthesized.tool_call).toBe(false)

      const resolved: ResolvedModel = {
        limit: { context: synthesized.limit.context },
        capabilities: { toolcall: synthesized.tool_call },
      }
      expect(modelCapabilityStatus(resolved)).toBe("unverified")
      expect(modelWarning(resolved)).toBeDefined()
    }),
  )
})
