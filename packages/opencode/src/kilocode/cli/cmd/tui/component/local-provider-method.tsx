// kilocode_change - new file
//
// "Add a local provider" TUI dialog (EPIC 5 Task 5.2).
//
// Three-step wizard, modeled on `AnacondaDesktopSetup`
// (`@/kilocode/anaconda-desktop/tui/setup.tsx`), but for the generic case: any
// openai-compatible endpoint (Ollama, LM Studio, or a user-supplied baseURL) rather than
// the anaconda-desktop-managed one.
//
//   1. DialogSelect a preset (Ollama / LM Studio / OpenAI-compatible).
//   2. DialogPrompt the baseURL (defaulted from LOCAL_PRESETS for ollama/lmstudio;
//      required for openai-compatible).
//   3. DialogPrompt an optional API key (default "local").
//
// On submit, writes `{ type: "api", key, metadata: { baseURL, preset } }` to the GLOBAL
// auth store only (`sdk.client.auth.set`) — never to project config, preserving the
// `{env:}` project-config security invariant (`@/config/variable.ts`).

import { createSignal, Show, type JSX } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { LOCAL_PRESETS, localProviderLabel, validateLocalBaseURL, type LocalPresetID } from "@/kilocode/provider/local-provider"

type ModelComponent = (props: { providerID?: string }) => JSX.Element

const PRESET_OPTIONS: { title: string; value: LocalPresetID; description?: string }[] = [
  { title: "Ollama", value: "ollama", description: LOCAL_PRESETS.ollama },
  { title: "LM Studio", value: "lmstudio", description: LOCAL_PRESETS.lmstudio },
  { title: "OpenAI-compatible", value: "openai-compatible", description: "Custom base URL" },
]

export function LocalProviderMethod(props: { model: ModelComponent }) {
  const dialog = useDialog()

  return (
    <DialogSelect
      title="Add a local provider"
      options={PRESET_OPTIONS}
      onSelect={(option) =>
        dialog.replace(() => <LocalProviderBaseURLStep preset={option.value} model={props.model} />)
      }
    />
  )
}

function LocalProviderBaseURLStep(props: { preset: LocalPresetID; model: ModelComponent }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={`${localProviderLabel(props.preset, props.preset)} base URL`}
      placeholder="http://localhost:11434/v1"
      value={LOCAL_PRESETS[props.preset] ?? ""}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>The OpenAI-compatible base URL, e.g. http://localhost:11434/v1.</text>
          <Show when={error()}>
            <text fg={theme.error}>Enter a valid http(s) base URL.</text>
          </Show>
        </box>
      )}
      onConfirm={(value) => {
        const baseURL = validateLocalBaseURL(value)
        if (!baseURL) {
          setError(true)
          return
        }
        dialog.replace(() => <LocalProviderKeyStep preset={props.preset} baseURL={baseURL} model={props.model} />)
      }}
    />
  )
}

function LocalProviderKeyStep(props: { preset: LocalPresetID; baseURL: string; model: ModelComponent }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const Model = props.model
  const providerID = props.preset

  async function submit(rawKey: string) {
    const key = rawKey.trim() || "local"
    await sdk.client.auth.set({
      providerID,
      auth: {
        type: "api",
        key,
        metadata: { baseURL: props.baseURL, preset: props.preset },
      },
    })
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    dialog.replace(() => <Model providerID={providerID} />)
  }

  return (
    <DialogPrompt
      title="API key (optional)"
      placeholder="local"
      description={() => (
        <text fg={theme.textMuted}>Most local servers don't require a key. Leave empty to use "local".</text>
      )}
      onConfirm={(value) => void submit(value)}
    />
  )
}
