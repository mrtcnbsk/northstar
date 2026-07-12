// kilocode_change - new file
//
// Local-model capability validation (EPIC 5 Task 5.3).
//
// A local/openai-compatible model discovered via `ModelCache`'s `aperture()` synth
// (`@/provider/model-cache.ts`) carries no real capability metadata unless:
//   - it matches a models.dev catalog entry for the same providerID/id (preserved by
//     `withKnownCapabilities` in `@/kilocode/provider/local-provider.ts`), or
//   - the user explicitly sets `limit.context`/`tool_call` in their config (the
//     "extend database from config" merge in `@/provider/provider.ts`).
//
// This module is the single place that decides "verified" vs "unverified" for a resolved
// model, and produces the visible warning string surfaced by the TUI
// (`@/kilocode/components/model-info-panel.tsx`) and the CLI (`@/cli/cmd/models.ts`).
//
// It bridges three different shapes of "does this model support tool calling":
//   - models.dev catalog / user config: `tool_call` (snake_case boolean,
//     `@opencode-ai/core/models-dev`'s `Model.tool_call`)
//   - the runtime `Provider.Model.capabilities`: `toolcall` (camelCase boolean)
//   - Anaconda Desktop (`@/kilocode/anaconda-desktop/domain.ts`): `ToolCapability`, a genuine
//     3-state ("supported" | "unsupported" | "unknown")
//
// `context` is the decisive signal for verified/unverified: `session/overflow.ts` already
// treats `limit.context === 0` as "unknown" (compaction OFF, the safe default) and
// `@/kilocode/anaconda-desktop/provider.ts` already treats unconfirmed tool-call support as
// `toolcall: false` (`metadata.toolcall === "supported"`). A plain boolean can't express
// "unknown" on its own, so this module treats a boolean paired with an unknown (<=0) context
// as unverified rather than trusting the boolean at face value — the exact same convention
// `aperture()` now follows when it can't confirm a model's real capabilities.

import { warning as anacondaWarning, type ToolCapability } from "@/kilocode/anaconda-desktop/domain"

export type CapabilityStatus = "verified" | "unverified"

/** The minimal shape needed to decide verified/unverified — bridges runtime + Anaconda inputs. */
export interface ResolvedCapabilities {
  /** `Provider.Model.limit.context` (or `ModelsDev.Model.limit.context`). 0/absent = unknown. */
  context: number
  /** Bridges `Provider.Model.capabilities.toolcall` (bool), `ModelsDev.Model.tool_call` (bool), and Anaconda's 3-state. */
  toolcall: boolean | ToolCapability
}

/** The minimal resolved-model shape this module consumes (structurally compatible with `Provider.Model`). */
export interface ResolvedModel {
  limit: { context: number }
  capabilities: { toolcall: boolean }
}

function resolved(model: ResolvedModel): ResolvedCapabilities {
  return { context: model.limit.context, toolcall: model.capabilities.toolcall }
}

/** Normalizes a boolean or 3-state tool-call signal into Anaconda's `ToolCapability` shape. */
export function toToolCapability(input: ResolvedCapabilities): ToolCapability {
  if (typeof input.toolcall !== "boolean") return input.toolcall
  if (input.context <= 0) return "unknown"
  return input.toolcall ? "supported" : "unsupported"
}

/** "verified" only when BOTH the context window and tool-call support are confirmed. */
export function capabilityStatus(input: ResolvedCapabilities): CapabilityStatus {
  if (input.context <= 0) return "unverified"
  if (toToolCapability(input) === "unknown") return "unverified"
  return "verified"
}

export function isVerified(input: ResolvedCapabilities): boolean {
  return capabilityStatus(input) === "verified"
}

/** Convenience overloads of the above that take a resolved `Provider.Model` directly. */
export function modelCapabilityStatus(model: ResolvedModel): CapabilityStatus {
  return capabilityStatus(resolved(model))
}

export function isModelVerified(model: ResolvedModel): boolean {
  return isVerified(resolved(model))
}

const BOTH_UNVERIFIED =
  "This local model's context window and tool-calling support are unverified — tool calls may fail and compaction is disabled. Set limit.context and tool_call in your config to enable them."
const CONTEXT_ONLY_UNVERIFIED =
  "This local model's context window could not be confirmed, so automatic compaction is disabled. Set limit.context in your config to enable it."

/**
 * Reusable string producer — generalizes Anaconda's `warning(toolcall)` +
 * `ready()` "Limited tool support" pattern (`@/kilocode/anaconda-desktop/domain.ts`,
 * `@/kilocode/anaconda-desktop/tui/model.ts`) to any resolved model, local or not. Returns
 * `undefined` for a verified model so callers can `Show when={warning()}`.
 */
export function localModelWarning(input: ResolvedCapabilities): string | undefined {
  if (isVerified(input)) return undefined
  const contextUnverified = input.context <= 0
  const toolMessage = anacondaWarning(toToolCapability(input))

  if (contextUnverified && toolMessage) return BOTH_UNVERIFIED
  if (contextUnverified) return CONTEXT_ONLY_UNVERIFIED
  // Context is confirmed but tool-call support alone is unverified (e.g. an Anaconda server
  // that reports a real context window while tool-call probing is still "unknown").
  return toolMessage && `${toolMessage} Set tool_call in your config to confirm support.`
}

export function modelWarning(model: ResolvedModel): string | undefined {
  return localModelWarning(resolved(model))
}

export * as LocalModelValidation from "./local-model-validation"
