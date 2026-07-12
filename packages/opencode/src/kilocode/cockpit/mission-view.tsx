// kilocode_change - new file
/** Props-only Mission Control panels. Data loading and mutation stay in CockpitView. */
import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import type { EvaluatorPanel, LoopGaugeVM } from "./cockpit-view"

export function MissionEvaluatorPanel(props: { panel: EvaluatorPanel }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Evaluator
      </text>
      <Show when={props.panel.stage} fallback={<text fg={theme.textMuted}>No active stage to evaluate.</text>}>
        <box flexDirection="row" gap={2}>
          <text fg={theme.text}>{props.panel.stage}</text>
          <text fg={theme.textMuted}>{`iteration ${props.panel.iteration}/${props.panel.maxIterations}`}</text>
          <Show when={props.panel.passed === true}>
            <text fg={theme.success}>PASS</text>
          </Show>
          <Show when={props.panel.passed === false}>
            <text fg={theme.warning}>FAIL</text>
          </Show>
        </box>
        <For each={props.panel.criteria}>
          {(criterion) => (
            <text fg={criterion.met ? theme.success : theme.error}>
              {`${criterion.met ? "✓" : "✗"} ${criterion.text}`}
            </text>
          )}
        </For>
        <Show when={props.panel.latestRejection}>
          <text fg={theme.error}>{`↳ ${props.panel.latestRejection}`}</text>
        </Show>
      </Show>
    </box>
  )
}

export function MissionLoopGauge(props: { gauge: LoopGaugeVM }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={2} border={["top"]} borderColor={theme.border} paddingTop={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Loop
      </text>
      <text fg={props.gauge.atLimit ? theme.error : theme.textMuted}>
        {`iter ${props.gauge.iteration}/${props.gauge.maxIterations}`}
      </text>
      <text fg={theme.textMuted}>{props.gauge.elapsed}</text>
      <text fg={theme.textMuted}>{`eval: ${props.gauge.evaluatorModel}`}</text>
    </box>
  )
}
