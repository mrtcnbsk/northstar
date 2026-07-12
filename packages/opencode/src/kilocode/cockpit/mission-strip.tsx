// kilocode_change - new file
/** Presentational conversation strip; CockpitView owns keybindings and all HTTP dispatch. */
import { For, Show } from "solid-js"
import type { KeyEvent, TextareaRenderable } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { ConversationCard } from "./conversation"

export type StripMode = "idle" | "note" | "revise-note" | "plan-edit" | "sent"

export function MissionStrip(props: {
  card: ConversationCard
  mode: StripMode
  sent: string | undefined
  onSubmitNote: (text: string) => void
  onCancelNote: () => void
}) {
  const { theme } = useTheme()
  let textarea: TextareaRenderable | undefined

  return (
    <box flexDirection="column" flexShrink={0} border={["top"]} borderColor={theme.border} paddingTop={1} gap={1}>
      <Show when={props.card.kind === "plan"}>
        {(() => {
          const card = props.card as Extract<ConversationCard, { kind: "plan" }>
          return (
            <box flexDirection="column" gap={1}>
              <text fg={theme.text}>{`Plan: ${card.stage}  [a] approve  [e] edit criteria`}</text>
              <For each={card.criteria}>{(criterion) => <text fg={theme.textMuted}>{`• ${criterion}`}</text>}</For>
            </box>
          )
        })()}
      </Show>

      <Show when={props.card.kind === "escalation"}>
        {(() => {
          const card = props.card as Extract<ConversationCard, { kind: "escalation" }>
          return (
            <box flexDirection="column" gap={1}>
              <text fg={theme.warning}>{`Escalation: ${card.stage}  [s] steer  [n] no-go`}</text>
              <text fg={theme.textMuted}>{card.detail}</text>
              <For each={card.reasons}>{(reason) => <text fg={theme.error}>{`↳ ${reason}`}</text>}</For>
            </box>
          )
        })()}
      </Show>

      <Show when={props.card.kind === "final_gate"}>
        {(() => {
          const card = props.card as Extract<ConversationCard, { kind: "final_gate" }>
          return (
            <box flexDirection="column" gap={1}>
              <text fg={theme.warning}>{`Final gate: ${card.stage}  [a] approve  [r] revise  [c] cancel`}</text>
              <text fg={theme.textMuted}>{card.detail}</text>
            </box>
          )
        })()}
      </Show>

      <Show when={props.card.kind === "none" && props.mode === "idle"}>
        <text fg={theme.textMuted}>[m] message an agent (prefix @name to target one)</text>
      </Show>

      <Show when={props.mode === "note" || props.mode === "revise-note" || props.mode === "plan-edit"}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.textMuted}>
            {props.mode === "revise-note"
              ? "What should change? (enter send, esc cancel)"
              : props.mode === "plan-edit"
                ? "Edit criteria (separate with ; then enter)"
                : "Message (@name to target; enter send, esc cancel)"}
          </text>
          <textarea
            ref={(value: TextareaRenderable) => {
              textarea = value
              queueMicrotask(() => value.focus())
            }}
            focused
            minHeight={1}
            maxHeight={4}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            keyBindings={[{ name: "return", action: "submit" }]}
            onKeyDown={(event: KeyEvent) => {
              if (event.name === "escape") props.onCancelNote()
            }}
            onSubmit={() => {
              const value = textarea?.plainText?.trim() ?? ""
              if (value) props.onSubmitNote(value)
            }}
          />
        </box>
      </Show>

      <Show when={props.mode === "sent"}>
        <text fg={theme.success}>{props.sent}</text>
      </Show>
    </box>
  )
}
