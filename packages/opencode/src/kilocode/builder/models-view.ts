// kilocode_change - new file
//
// Pure view-model for the Builder "Models" screen (EPIC 6 Task 6.1).
//
// Reshapes the raw `Provider[]` from `useSync().data.provider` into a flat,
// render-ready structure grouped by provider, with per-model capability
// verification folded in. Kept free of any I/O / Solid reactivity so it can
// be unit tested directly — the render layer (`models-screen.tsx`) is a thin
// wrapper that feeds this the live sync data.

import type { Model, Provider } from "@kilocode/sdk/v2"
import { sortBy } from "remeda"
import { isLocalPreset } from "@/kilocode/provider/local-provider"
import { isModelVerified } from "@/kilocode/provider/local-model-validation"
import { avgPrice } from "@/kilocode/components/model-info-panel-utils"

export interface ModelRow {
  id: string
  context: number
  toolcall: boolean
  cost: number
  verified: boolean
}

export interface ProviderRow {
  providerID: string
  name: string
  connected: boolean
  klass: "local" | "hosted"
  models: ModelRow[]
}

// `avgPrice` reads `cost.cache.read`, which a minimal/synthesized model (e.g. a freshly
// discovered local-provider model) may not carry — fall back to the raw input price, and
// to 0 when there's no cost info at all.
function modelCost(cost: Model["cost"] | undefined): number {
  if (!cost) return 0
  if (cost.cache) return avgPrice(cost)
  return cost.input ?? 0
}

function modelRow(model: Model): ModelRow {
  return {
    id: model.id,
    context: model.limit?.context ?? 0,
    toolcall: model.capabilities?.toolcall ?? false,
    cost: modelCost(model.cost),
    verified: isModelVerified(model),
  }
}

export function buildProviderRows(providers: Provider[], connectedIDs: ReadonlySet<string>): ProviderRow[] {
  return providers.map((provider) => ({
    providerID: provider.id,
    name: provider.name,
    connected: connectedIDs.has(provider.id),
    klass: isLocalPreset(provider.id) ? "local" : "hosted",
    models: sortBy(Object.values(provider.models).map(modelRow), (m) => m.id),
  }))
}
