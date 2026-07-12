// kilocode_change - new file
// Task 7.4 (EPIC 7 / TUI Chat): inline a/n/r gate card. Rendered directly next to the
// `org_advance` ToolPart that surfaced the gate (see the injection in
// routes/session/index.tsx's `ToolPart` renderer) rather than in the footer-prompt
// region used by PermissionPrompt/QuestionPrompt/SuggestPrompt - a human_gate is data
// sitting on a completed ToolPart, not a synced pending-request state map the way
// permission/question/suggestion requests are, so there is nothing for a footer overlay
// to key off of without inventing new synced server state. Modeled on permission.tsx's
// Prompt/RejectPrompt layout (bordered box, clickable option row, textarea-for-note
// sub-stage), but inline in the scroll flow instead of a fixed footer overlay.
//
// org_decision is a CEO-scoped tool with no HTTP path (organization/tools.ts), so there
// is no request/reply endpoint to call here. Instead this sends a plain CEO-instruction
// chat message via sdk.client.session.prompt - the SAME call the composer uses to submit
// a prompt (component/prompt/index.tsx's submitInner) - into the CURRENT session,
// addressed to the SAME agent that produced this org_advance call (props.agent, i.e. the
// owning message's `.agent` - whatever the org's CEO happens to be named, never
// hardcoded). The CEO's gate protocol (templates/ios-app-factory/agents/ceo.md, step 4)
// already turns a user decision into `org_decision` + `org_advance`; the message text
// below spells out the exact decision literal ("approve"/"no-go"/"revise") so an LLM
// reading it maps it unambiguously.
import { createSignal, Show } from "solid-js"
import type { TextareaRenderable, KeyEvent } from "@opentui/core"
import type { ToolPart } from "@kilocode/sdk/v2"
import { SplitBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { PartID } from "@/session/schema"
import type { GateCard } from "@/kilocode/cli/cmd/tui/gate-card"

type Stage = "choice" | "revise-note" | "sent"

/** kilocode_change - the run_id org_advance's own output never echoes back (see
 * gate-card.ts's doc comment); falls back to a human-readable placeholder so the sent
 * message still reads sensibly ("approve run the current run") - the CEO already knows
 * which run is awaiting a decision from session context either way. */
function runRef(card: GateCard) {
  return card.runID ?? "the current run"
}

export function OrgGateCard(props: { part: ToolPart; sessionID: string; agent: string; card: GateCard }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const [stage, setStage] = createSignal<Stage>("choice")
  const [sentLabel, setSentLabel] = createSignal<string>()
  let textarea: TextareaRenderable | undefined

  function send(text: string, label: string) {
    setStage("sent")
    setSentLabel(label)
    void sdk.client.session
      .prompt({
        sessionID: props.sessionID,
        agent: props.agent,
        parts: [{ id: PartID.ascending(), type: "text", text }],
      })
      .catch(() => {})
  }

  const approve = () => send(`approve run ${runRef(props.card)}`, "Approved")
  const noGo = () => send(`reject run ${runRef(props.card)} (no-go)`, "Rejected (no-go)")
  const revise = (note: string) => send(`revise run ${runRef(props.card)}: ${note}`, `Requested revision: ${note}`)

  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={3}
      marginTop={1}
      gap={1}
      backgroundColor={theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.warning}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.warning}>{"◆"}</text>
        <text fg={theme.text}>{"Gate: " + props.card.stage}</text>
      </box>
      <Show when={props.card.deliverable}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>{"Deliverable: " + props.card.deliverable}</text>
        </box>
      </Show>
      <Show when={props.card.budgetNote}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>{"Budget: " + props.card.budgetNote}</text>
        </box>
      </Show>

      <Show when={stage() === "choice"}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundMenu} onMouseUp={approve}>
            <text fg={theme.success}>a) approve</text>
          </box>
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundMenu} onMouseUp={noGo}>
            <text fg={theme.error}>n) no-go</text>
          </box>
          <box
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme.backgroundMenu}
            onMouseUp={() => setStage("revise-note")}
          >
            <text fg={theme.warning}>r) revise</text>
          </box>
        </box>
      </Show>

      <Show when={stage() === "revise-note"}>
        <box gap={1} paddingLeft={1}>
          <text fg={theme.textMuted}>What should change? (enter to send, esc to cancel)</text>
          <textarea
            ref={(val: TextareaRenderable) => {
              textarea = val
              queueMicrotask(() => val.focus())
            }}
            focused
            minHeight={1}
            maxHeight={4}
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            onKeyDown={(event: KeyEvent) => {
              if (event.name === "escape") setStage("choice")
            }}
            onSubmit={() => {
              const note = textarea?.plainText?.trim() ?? ""
              if (!note) return
              revise(note)
            }}
          />
        </box>
      </Show>

      <Show when={stage() === "sent"}>
        <box paddingLeft={1}>
          <text fg={theme.success}>{sentLabel() + " - sent to " + props.agent}</text>
        </box>
      </Show>
    </box>
  )
}
