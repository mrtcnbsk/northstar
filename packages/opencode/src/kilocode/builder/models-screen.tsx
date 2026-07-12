// kilocode_change - new file
//
// Builder "Models" screen (EPIC 6 Task 6.1).
//
// In-route panel (mounted inside the Builder route's content box by
// `view.tsx`) — NOT a dialog wrapper. Lists every known provider's models in
// the same two-column list+preview layout as `dialog-model.tsx` (list on the
// left via `DialogSelect`, `ModelInfoPanel` preview on the right once the
// terminal is wide enough), plus an "Add provider" list-level action that
// launches the EPIC 5.2 local-provider wizard (`LocalProviderMethod`).

import { createMemo, createSignal, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { Model } from "@kilocode/sdk/v2"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogModel } from "@tui/component/dialog-model"
import { LocalProviderMethod } from "@/kilocode/cli/cmd/tui/component/local-provider-method"
import { ModelInfoPanel } from "@/kilocode/components/model-info-panel"
import { fmtContext, fmtPrice } from "@/kilocode/components/model-info-panel-utils"
import { buildProviderRows, type ModelRow, type ProviderRow } from "./models-view"

type ModelValue = { providerID: string; modelID: string }

function describe(row: ProviderRow) {
  return row.connected ? row.klass : `${row.klass} · not connected`
}

function summarize(model: ModelRow) {
  const parts = [`ctx ${fmtContext(model.context)}`, `tool ${model.toolcall ? "✓" : "✗"}`, fmtPrice(model.cost)]
  if (!model.verified) parts.push("⚠")
  return parts.join(" · ")
}

export function ModelsScreen() {
  const sync = useSync()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()

  const wide = createMemo(() => dimensions().width >= 108)
  const [preview, setPreview] = createSignal<{ model: Model; provider: string }>()

  const rows = createMemo(() => buildProviderRows(sync.data.provider, new Set(sync.data.provider_next.connected)))

  function lookup(providerID: string, modelID: string) {
    const provider = sync.data.provider.find((x) => x.id === providerID)
    const model = provider?.models[modelID]
    if (!provider || !model) return
    return { model, provider: provider.name }
  }

  const options = createMemo<DialogSelectOption<ModelValue>[]>(() =>
    rows().flatMap((row) =>
      row.models.map((model) => ({
        value: { providerID: row.providerID, modelID: model.id },
        title: `${row.providerID}/${model.id}`,
        category: row.name,
        description: describe(row),
        footer: summarize(model),
      })),
    ),
  )

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      <box flexGrow={1} flexShrink={1}>
        <DialogSelect<ModelValue>
          title="Models"
          options={options()}
          actions={[
            {
              command: "builder.addProvider",
              title: "Add provider",
              requiresSelection: false,
              onTrigger: () => {
                dialog.replace(() => <LocalProviderMethod model={DialogModel} />)
              },
            },
          ]}
          bindings={[{ key: "a", cmd: "builder.addProvider" }]}
          onMove={(option) => {
            const next = lookup(option.value.providerID, option.value.modelID)
            setPreview(next)
          }}
        />
      </box>
      <Show when={wide() && preview()}>{(item) => <ModelInfoPanel model={item().model} provider={item().provider} />}</Show>
    </box>
  )
}
