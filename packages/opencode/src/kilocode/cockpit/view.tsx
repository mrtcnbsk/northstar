// kilocode_change - new file
/**
 * Cockpit full-screen view (Task 8.1b, EPIC 8).
 *
 * Renders the org-run dashboard for `route.data.runID` (the `/cockpit` command, `kilo-commands.tsx`,
 * sets the route with no runID for now — Task 8.3 adds a run-list picker; until then this view shows
 * a "no run selected" message). Mirrors the Builder route shell (`builder/view.tsx`: useRoute/
 * useDialog/useTheme, a view-scoped `useBindings` with an escape→back command) and the Kilo
 * Console's `OrgRunDetailRoute.tsx` poll pattern (`createResource` + a `createEffect` that polls
 * every 3s while `run.status === "active"`, cleaned up via `onCleanup`).
 *
 * Section data comes from the pure view-model builders in `./cockpit-view` (Task 8.1a + the small
 * additions above for this task): `stageTimeline`/`formatCost`/`badgeToThemeKey` (Pipeline),
 * `buildAgentTree` (Agent tree — Tier A: chief liveness from stage status, workers are the static
 * roster), `budgetFromRun`/`budgetGauge` (Budget gauge — degrades to "budget: n/a" when the run has
 * no budget block), and `auditTrail` (Activity log, newest first).
 *
 * The resource fetcher never lets the `orgRuns.detail` resource enter Solid's "errored" state (it
 * catches internally and tracks failures via a separate `loadError` signal) — reading an errored
 * resource's accessor re-throws, and the TUI's `<ErrorBoundary>` wraps the whole app, so an
 * unguarded throw here would crash the entire TUI rather than just this view.
 */

import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { parse as parseJsonc } from "jsonc-parser"
import { TextAttributes } from "@opentui/core"
import { useRoute } from "@tui/context/route"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select" // kilocode_change - Task 8.3: run-list home
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "@tui/keymap"
import { useSDK } from "@tui/context/sdk"
import { useProject } from "@tui/context/project"
import { PartID } from "@/session/schema"
import { OrgSchema } from "@/kilocode/organization/schema"
import type { OrgRunDetailResponse } from "@kilocode/sdk/v2/client"
import {
  auditTrail,
  badgeToThemeKey,
  budgetFromRun,
  budgetGauge,
  buildAgentTree,
  buildRunList, // kilocode_change - Task 8.3: run-list home
  formatCost,
  stageTimeline,
  type BudgetGauge,
} from "./cockpit-view"
// kilocode_change - Task 8.2: hard stop goes via the SAME CEO-instruction-message convention as
// the 7.4 gate card (gate-card.tsx's `send`) — never a direct `OrgRunner.stop` (the cockpit stays
// READ-ONLY over run state; see the EPIC 8 plan's determinism/security invariants).
import { stopMessage } from "./stop"

// Mirrors the same relative path used by `/org-status` and the Builder Organization screen (see
// `kilo-commands.tsx`'s ORG_RELATIVE_PATH comment for the read-path rationale — this is the
// generic, already-public `file.read` endpoint, not an org-specific one).
const ORG_RELATIVE_PATH = ".kilo/organization.jsonc"
const POLL_INTERVAL_MS = 3000
const BAR_WIDTH = 30

function timestamp(input: string) {
  if (!input) return "—"
  const time = new Date(input)
  if (Number.isNaN(time.getTime())) return input
  return time.toLocaleString()
}

/** Renders the budget gauge as a block-character bar: filled up to `spentFraction`, with a marker
 * at `thresholdFraction`. Presentation-only (not exported/tested — the fractions it renders are
 * already covered by `budgetGauge`'s unit tests in 8.1a). */
function budgetBar(gauge: BudgetGauge, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(gauge.spentFraction * width)))
  const thresholdIndex = Math.max(0, Math.min(width - 1, Math.round(gauge.thresholdFraction * width) - 1))
  const chars: string[] = []
  for (let i = 0; i < width; i++) {
    chars.push(i === thresholdIndex ? "┃" : i < filled ? "█" : "░")
  }
  return chars.join("")
}

export function CockpitView() {
  const route = useRoute()
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const project = useProject()
  const toast = useToast() // kilocode_change - Task 8.2: gate/halt/budget notifications

  const runID = createMemo(() => (route.data.type === "cockpit" ? route.data.runID : undefined))
  // kilocode_change - Task 8.2: the CEO session the hard-stop control addresses (see route.tsx's
  // CockpitRoute.sessionID comment) — undefined when the Cockpit was opened without a known
  // owning session, in which case the stop control reports that rather than guessing a session.
  const sessionID = createMemo(() => (route.data.type === "cockpit" ? route.data.sessionID : undefined))
  const [loadError, setLoadError] = createSignal<string | undefined>()

  const [detail, { refetch }] = createResource(runID, async (id): Promise<OrgRunDetailResponse | undefined> => {
    setLoadError(undefined)
    try {
      const result = await sdk.client.orgRuns.detail({ runID: id, workspace: project.workspace.current() })
      if (result.error || !result.data) {
        setLoadError("Failed to load org run detail.")
        return undefined
      }
      return result.data
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      return undefined
    }
  })

  // Poll every 3s while the run is active (mirrors the Kilo Console's OrgRunDetailRoute).
  createEffect(() => {
    if (detail()?.run.status !== "active") return
    const timer = setInterval(() => void refetch(), POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Read .kilo/organization.jsonc once (client-side parse, same read path as /org-status and the
  // Builder Organization screen) — for the agent-tree section only.
  const [orgFile] = createResource(async () => {
    const result = await sdk.client.file.read({ path: ORG_RELATIVE_PATH, workspace: project.workspace.current() })
    if (result.error || !result.data) return undefined
    const content = result.data.type === "text" ? result.data.content.trim() : ""
    if (!content) return undefined
    try {
      return OrgSchema.parse(parseJsonc(content))
    } catch {
      return undefined
    }
  })

  // kilocode_change start - Task 8.3: run-list home. Fetches ONLY when the Cockpit was opened
  // without a runID (the run picker below) -- once a run is selected, `detail` above takes over and
  // this resource goes idle (createResource's source returns undefined whenever runID() is set).
  const [runsList] = createResource(
    () => (runID() ? undefined : true),
    async () => {
      const result = await sdk.client.orgRuns.list({ workspace: project.workspace.current() })
      if (result.error || !result.data) return []
      return result.data.runs
    },
  )
  const runRows = createMemo(() => buildRunList(runsList() ?? []))
  // kilocode_change end

  const stages = createMemo(() => stageTimeline(detail()))
  const audit = createMemo(() => [...auditTrail(detail())].reverse())
  const tree = createMemo(() => {
    const org = orgFile()
    const run = detail()
    if (!org || !run) return undefined
    return buildAgentTree(org, run)
  })
  const budgetInput = createMemo(() => {
    const run = detail()
    return run?.budget ? budgetFromRun(run.budget) : undefined
  })
  const gauge = createMemo(() => {
    const input = budgetInput()
    return input ? budgetGauge(input) : undefined
  })

  // kilocode_change start - Task 8.2: gate/halt/budget notifications, fired ONCE per transition.
  // Tracks the previous poll's snapshot (per-stage status, run status, escalated) and compares it
  // to the current `detail()` on every change; `prev` stays undefined until the first snapshot is
  // recorded, so the initial load never fires a toast for state that was already true on arrival —
  // only a genuine transition (prev !== awaiting_approval -> now awaiting_approval, etc.) does. The
  // snapshot is then overwritten with the new state every time, so a transition is only ever
  // detected once (the NEXT poll's "previous" already reflects it).
  type NotifySnapshot = { stageStatus: Record<string, string>; runStatus: string; escalated: boolean }
  const [prevSnapshot, setPrevSnapshot] = createSignal<NotifySnapshot | undefined>()

  createEffect(() => {
    const run = detail()
    if (!run) return
    const nextStageStatus: Record<string, string> = {}
    for (const stage of run.stages) nextStageStatus[stage.stage] = stage.status

    const prev = prevSnapshot()
    if (prev) {
      for (const stage of run.stages) {
        if (stage.status === "awaiting_approval" && prev.stageStatus[stage.stage] !== "awaiting_approval") {
          toast.show({ message: `Gate: ${stage.stage} awaiting approval`, variant: "warning" })
        }
      }
      if (run.run.status === "halted" && prev.runStatus !== "halted") {
        toast.show({ message: `Run halted: ${run.run.haltReason ?? "no reason recorded"}`, variant: "error" })
      }
      if (run.run.escalated && !prev.escalated) {
        toast.show({ message: "Budget escalation threshold crossed", variant: "warning" })
      }
    }

    setPrevSnapshot({ stageStatus: nextStageStatus, runStatus: run.run.status, escalated: !!run.run.escalated })
  })
  // kilocode_change end

  // kilocode_change start - Task 8.2: hard stop. NEVER calls `OrgRunner.stop` directly (the
  // cockpit is READ-ONLY over run state) — sends a plain CEO-instruction chat message via
  // sdk.client.session.prompt, the SAME send mechanism the 7.4 gate card uses
  // (routes/session/gate-card.tsx's `send`), into the CEO's own session. `ceo.md`'s protocol step
  // 8 recognizes a "stop run <id>: <reason>" message and turns it into `org_stop(run_id, reason)`.
  async function hardStop() {
    const sid = sessionID()
    if (!sid) {
      toast.show({
        message: "Stop requires opening the Cockpit from its originating CEO session.",
        variant: "error",
      })
      return
    }
    const reason = await DialogPrompt.show(dialog, "Stop run", {
      placeholder: "Reason for stopping (sent to the CEO)",
    })
    if (reason === null) return
    const trimmed = reason.trim()
    if (!trimmed) return
    void sdk.client.session
      .prompt({
        sessionID: sid,
        parts: [{ id: PartID.ascending(), type: "text", text: stopMessage(runID(), trimmed) }],
      })
      .catch(() => {})
    toast.show({ message: "Stop request sent to the CEO.", variant: "info" })
  }
  // kilocode_change end

  useBindings(() => ({
    commands: [
      {
        namespace: "palette",
        name: "cockpit.back",
        title: "Back",
        desc: "Return to the previous view",
        category: "Cockpit",
        run: () => {
          dialog.clear()
          route.back()
        },
      },
      // kilocode_change - Task 8.2: hard stop keybinding
      {
        namespace: "palette",
        name: "cockpit.stop",
        title: "Stop run",
        desc: "Send a hard-stop instruction to the CEO for the current run",
        category: "Cockpit",
        run: () => void hardStop(),
      },
    ],
    bindings: [
      { key: "escape", cmd: "cockpit.back" },
      { key: "s", cmd: "cockpit.stop" }, // kilocode_change - Task 8.2
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingTop={1} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Cockpit
      </text>

      {/* kilocode_change start - Task 8.3: run-list home (no runID -> pick a run) */}
      <Show when={!runID()}>
        <Show when={runsList.loading && !runsList()}>
          <text fg={theme.textMuted}>Loading org runs...</text>
        </Show>
        <Show when={!runsList.loading && runsList() && runRows().length === 0}>
          <text fg={theme.textMuted}>No org runs yet. Start one from a shell: northstar run --auto "your idea"</text>
        </Show>
        <Show when={runRows().length > 0}>
          <DialogSelect
            title="Org Runs"
            skipFilter={true}
            renderFilter={false}
            options={runRows().map((row) => ({
              title: row.idea || row.runID,
              description: `${row.status}${row.awaitingGate ? " · awaiting gate" : ""}`,
              footer: formatCost(row.totalCost),
              value: row.runID,
            }))}
            onSelect={(option) => {
              route.navigate({ type: "cockpit", runID: option.value, sessionID: sessionID() })
            }}
          />
        </Show>
      </Show>
      {/* kilocode_change end */}

      <Show when={runID() && detail.loading && !detail()}>
        <text fg={theme.textMuted}>Loading run {runID()}...</text>
      </Show>

      <Show when={runID() && loadError()}>
        <text fg={theme.error}>{loadError()}</text>
      </Show>

      <Show when={detail()}>
        <box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
          <box flexDirection="row" gap={2}>
            <text fg={theme.text}>{detail()!.run.idea}</text>
            <text fg={theme.textMuted}>{detail()!.run.status}</text>
            <text fg={theme.textMuted}>
              {formatCost(typeof detail()!.totalCost === "number" ? (detail()!.totalCost as number) : 0)}
            </text>
            {/* kilocode_change - Task 8.2: hard-stop hint (s) */}
            <text fg={theme.textMuted}>s: stop run</text>
          </box>

          {/* kilocode_change - Task 8.2: budget gauge moved into the header (right under the run
              summary row, above Pipeline/Agent-tree/Activity) so it's always visible without
              scrolling, per the EPIC 8 plan's "always-visible budget" requirement. */}
          <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Budget
            </text>
            <Show when={gauge()} fallback={<text fg={theme.textMuted}>budget: n/a</text>}>
              <box flexDirection="column">
                <text fg={gauge()!.overCeiling ? theme.error : gauge()!.overThreshold ? theme.warning : theme.success}>
                  {budgetBar(gauge()!, BAR_WIDTH)}
                </text>
                <box flexDirection="row" gap={2}>
                  <text fg={theme.textMuted}>
                    {formatCost(budgetInput()!.spent)} / {formatCost(budgetInput()!.run)}
                  </text>
                  <Show when={gauge()!.escalated}>
                    <text fg={theme.error}>escalated</text>
                  </Show>
                </box>
              </box>
            </Show>
          </box>

          {/* Pipeline */}
          <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Pipeline
            </text>
            <Show when={stages().length === 0}>
              <text fg={theme.textMuted}>No stages recorded yet.</text>
            </Show>
            <For each={stages()}>
              {(stage) => (
                <box flexDirection="row" gap={2}>
                  <text fg={theme.text} width={16}>
                    {stage.stage}
                  </text>
                  <text fg={theme[badgeToThemeKey(stage.badgeVariant)]} width={16}>
                    {stage.status.replace(/_/g, " ")}
                  </text>
                  <text fg={theme.textMuted}>{formatCost(stage.cost)}</text>
                </box>
              )}
            </For>
          </box>

          {/* Agent tree */}
          <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Agent tree
            </text>
            <Show when={tree()} fallback={<text fg={theme.textMuted}>No .kilo/organization.jsonc found.</text>}>
              <box flexDirection="column">
                <text fg={theme.primary}>
                  {tree()!.ceo} <span style={{ fg: theme.textMuted }}>ceo</span>
                </text>
                <For each={tree()!.departments}>
                  {(dept) => (
                    <box flexDirection="column" paddingLeft={2}>
                      <text fg={theme.text}>
                        {dept.chief} <span style={{ fg: theme.textMuted }}>[{dept.status}]</span>
                      </text>
                      <text fg={theme.textMuted} paddingLeft={2}>
                        {dept.workers.join(", ")}
                      </text>
                    </box>
                  )}
                </For>
              </box>
            </Show>
          </box>

          {/* Activity log */}
          <box flexDirection="column" flexGrow={1} minHeight={0} border={["top"]} borderColor={theme.border} paddingTop={1}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              Activity
            </text>
            <Show when={audit().length === 0}>
              <text fg={theme.textMuted}>No approval activity recorded yet.</text>
            </Show>
            <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
              <For each={audit()}>
                {(entry) => (
                  <text fg={theme.textMuted}>
                    {timestamp(entry.ts)} {entry.stage} {entry.decision} {entry.note ?? "—"}
                  </text>
                )}
              </For>
            </scrollbox>
          </box>
        </box>
      </Show>
    </box>
  )
}
