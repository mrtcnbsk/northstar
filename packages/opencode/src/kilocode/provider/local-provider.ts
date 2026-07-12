// kilocode_change - new file
//
// Generic local / openai-compatible provider registration (EPIC 5 Task 5.2).
//
// A "local provider" is any GLOBAL auth.json entry (see `@/auth`) keyed by an arbitrary
// providerID (e.g. "ollama", "lmstudio", or a user-chosen id for a custom
// openai-compatible endpoint) whose `Auth.Api` metadata carries `{ baseURL, preset }`.
// This module generalizes the pattern already used for Anaconda Desktop
// (`@/kilocode/anaconda-desktop/provider.ts`) and Apertis (`@/provider/models.ts`
// `addApertis`) so ANY such entry resolves into an `@ai-sdk/openai-compatible` provider,
// with models discovered via the model-cache openai-compatible `/models` fetch
// (`ModelCache` — see `fetchOpenAICompatibleModels` in `@/provider/model-cache.ts`).
//
// Credentials for local providers are written ONLY to the global auth store
// (`Auth.Service.set`) by the TUI "Add a local provider" dialog — never to project
// config — preserving the `{env:}` project-config security invariant documented in
// `@/config/variable.ts`.

import type { Provider } from "@opencode-ai/core/models-dev"
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import type { Auth } from "@/auth"
import type { ModelCache } from "@/provider/model-cache"
import { normalizeLoopbackEndpoint } from "@/kilocode/anaconda-desktop/domain"

const log = Log.create({ service: "local-provider" })

/** Default base URLs for well-known local presets. `openai-compatible` is always user-entered. */
export const LOCAL_PRESETS = {
  ollama: "http://localhost:11434/v1",
  lmstudio: "http://localhost:1234/v1",
  "openai-compatible": undefined,
} as const satisfies Record<string, string | undefined>

export type LocalPresetID = keyof typeof LOCAL_PRESETS

export function isLocalPreset(value: string): value is LocalPresetID {
  return Object.prototype.hasOwnProperty.call(LOCAL_PRESETS, value)
}

const PRESET_LABELS: Record<LocalPresetID, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  "openai-compatible": "OpenAI-compatible",
}

/** Friendly display name for a local provider: the preset's label, or the providerID itself. */
export function localProviderLabel(providerID: string, preset: string | undefined) {
  if (preset && isLocalPreset(preset)) return PRESET_LABELS[preset]
  return providerID
}

/**
 * Relaxed baseURL validation for the "Add a local provider" dialog.
 *
 * Loopback endpoints (the common case — Ollama/LM Studio running on this machine) are
 * validated and normalized with the strict anaconda-desktop `normalizeLoopbackEndpoint`
 * (enforces http://, a loopback host, and a `/`, `/v1`, or empty path). Non-loopback hosts
 * (a remote/self-hosted openai-compatible gateway) are accepted with a relaxed check —
 * valid http(s) URL, no embedded credentials — since the anaconda-desktop invariant
 * (localhost-only) does not apply to a user-supplied openai-compatible endpoint.
 */
export function validateLocalBaseURL(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  const loopback = normalizeLoopbackEndpoint(trimmed)
  if (loopback) return loopback
  if (!URL.canParse(trimmed)) return undefined
  const url = new URL(trimmed)
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (url.username || url.password) return undefined
  return trimmed.replace(/\/+$/, "")
}

type LocalMetadata = { baseURL: string; preset: string }

// Both `baseURL` AND `preset` must be present to recognize an auth entry as a local
// provider — this is the exact shape the "Add a local provider" dialog writes
// (`src/kilocode/cli/cmd/tui/component/local-provider-method.tsx`). Requiring `preset`
// (not just `baseURL`) keeps this from misfiring on unrelated auth metadata that happens
// to carry a `baseURL` key for a different reason — e.g. the anaconda-desktop auth entry
// (`@/kilocode/anaconda-desktop/domain`'s `Metadata`) also has a `baseURL` field but no
// `preset`, and is resolved entirely through its own plugin (`@/kilocode/anaconda-desktop/provider.ts`)
// instead of this module.
function localMetadata(metadata: Record<string, string> | undefined): LocalMetadata | undefined {
  const baseURL = metadata?.["baseURL"]
  const preset = metadata?.["preset"]
  if (!baseURL || !preset) return undefined
  return { baseURL, preset }
}

/**
 * EPIC 5 Task 5.3: since a discovered openai-compatible model's `/models` response carries no
 * capability metadata, `aperture()` (`@/provider/model-cache.ts`) now marks it UNVERIFIED
 * (`tool_call:false`, `limit.context/output:0`) rather than blind-defaulting. But when the
 * discovered id ALSO exists in the models.dev catalog's prior entry for this providerID (e.g.
 * models.dev ships a static "lmstudio" entry with a handful of known models/capabilities — see
 * the module docstring above), that catalog data is real and verified — trust it over the
 * unverified synth so a known-good model is never flagged by
 * `@/kilocode/provider/local-model-validation.ts`.
 */
function withKnownCapabilities(discovered: Provider["models"][string], known: Provider["models"][string] | undefined) {
  if (!known) return discovered
  return {
    ...discovered,
    tool_call: known.tool_call,
    limit: known.limit,
    attachment: known.attachment,
    reasoning: known.reasoning,
    modalities: known.modalities,
  }
}

// Provider IDs resolved earlier in the SAME `ModelsDev.get()` call (`@/provider/models.ts`)
// with their own dedicated auth/config flow. A local-provider auth entry can never target
// these through the TUI (the preset list is fixed to ollama/lmstudio/openai-compatible),
// but a hand-edited auth.json could — never let stray local metadata clobber them.
const PROTECTED_PROVIDER_IDS = new Set(["kilo", "apertis"])

/**
 * Scans the auth store for entries carrying `{ baseURL, preset }` metadata and injects
 * each as an openai-compatible provider into `providers` (mutated in place, mirroring
 * `addApertis` in `@/provider/models.ts`). This intentionally CAN override a base-catalog
 * provider that shares the same id (e.g. models.dev already ships a static "lmstudio"
 * entry with a fixed baseURL and a handful of known models) — a user who explicitly walks
 * through the "Add a local provider" wizard for that preset wants THEIR live endpoint and
 * live model list, not the generic catalog stub. `kilo`/`apertis` — which this same
 * `get()` call resolves via their own dedicated flow — are the only ids left untouched
 * (see `PROTECTED_PROVIDER_IDS`).
 */
export const addLocalProviders = Effect.fn("LocalProvider.addLocalProviders")(function* (
  providers: Record<string, Provider>,
  auth: Auth.Interface,
  cache: ModelCache.Interface,
) {
  const all = yield* auth.all().pipe(Effect.catch(() => Effect.succeed({} as Record<string, Auth.Info>)))

  for (const [providerID, info] of Object.entries(all)) {
    if (info.type !== "api") continue
    const metadata = localMetadata(info.metadata)
    if (!metadata) continue
    if (PROTECTED_PROVIDER_IDS.has(providerID)) continue

    const catalogModels = providers[providerID]?.models // models.dev catalog entry, if any, BEFORE it's overwritten below
    const options = { baseURL: metadata.baseURL, apiKey: info.key }
    const discovered = yield* cache.fetch(providerID, options).pipe(Effect.catch(() => Effect.succeed({})))
    const models = Object.fromEntries(
      Object.entries(discovered).map(([id, model]) => [id, withKnownCapabilities(model, catalogModels?.[id])]),
    )
    providers[providerID] = {
      id: providerID,
      name: localProviderLabel(providerID, metadata.preset),
      env: [],
      api: metadata.baseURL,
      npm: "@ai-sdk/openai-compatible",
      models,
    }
    if (Object.keys(models).length === 0) {
      yield* cache.refresh(providerID, options).pipe(Effect.ignore, Effect.forkDetach)
    }
    log.info("local provider registered", { providerID, models: Object.keys(models).length })
  }
})

export * as LocalProvider from "./local-provider"
