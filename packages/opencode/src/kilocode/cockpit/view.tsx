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
import { useBindings, useOpencodeKeymap } from "@tui/keymap"
import { useSDK } from "@tui/context/sdk"
import { useProject } from "@tui/context/project"
import { OrgSchema } from "@/kilocode/organization/schema"
import type { OrgRunDetailResponse } from "@kilocode/sdk/v2/client"
import {
  auditTrail,
  badgeToThemeKey,
  buildEvaluatorPanel, // kilocode_change - SP2 Task 3
  budgetFromRun,
  budgetGauge,
  buildAgentTree,
  buildRunList, // kilocode_change - Task 8.3: run-list home
  formatCost,
  loopGauge, // kilocode_change - SP2 Task 3
  stageTimeline,
  type BudgetGauge,
} from "./cockpit-view"
import { MissionEvaluatorPanel, MissionLoopGauge } from "./mission-view" // kilocode_change - SP2 Task 3
import { conversationCard, missionCompletion, parseMention } from "./conversation" // kilocode_change - SP2 Task 5
import { MissionStrip, type StripMode } from "./mission-strip" // kilocode_change - SP2 Task 5
import { useOptionalWorkspace } from "@/kilocode/workspace/context"
import { MissionCompletionState, MissionEmptyState } from "./mission-states"

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
  const workspace = useOptionalWorkspace()
  const keymap = useOpencodeKeymap()

  const activeOrganization = () => workspace?.active()
  const routed = () => ({
    workspace: project.workspace.current(),
    ...(activeOrganization()?.id ? { organizationID: activeOrganization()!.id } : {}),
  })

  const runID = createMemo(() => (route.data.type === "cockpit" ? route.data.runID : undefined))
  // kilocode_change - Task 8.2: the CEO session the hard-stop control addresses (see route.tsx's
  // CockpitRoute.sessionID comment) — undefined when the Cockpit was opened without a known
  // owning session, in which case the stop control reports that rather than guessing a session.
  const sessionID = createMemo(() => (route.data.type === "cockpit" ? route.data.sessionID : undefined))
  const [loadError, setLoadError] = createSignal<string | undefined>()

  // kilocode_change start - wave-close review fix: keep the last-good detail across a transient
  // poll failure instead of letting the resource collapse to `undefined` (which blanked the whole
  // dashboard AND, via the poll effect below reading `detail()?.run.status`, permanently killed
  // polling since `undefined !== "active"`). Plain closure variables (not signals) -- mirrors
  // `context/route.tsx`'s `let previous` / `routes/session/index.tsx`'s `let processSessionID`:
  // this is cross-poll bookkeeping the fetcher reads/writes itself, not something a consumer needs
  // to react to. Keyed by organization + runID so switching either boundary never leaks the old
  // run's stale detail into a failed first fetch for the new one.
  let lastDetail: OrgRunDetailResponse | undefined
  let lastDetailKey: string | undefined
  // kilocode_change end

  const detailSource = createMemo(() => {
    const id = runID()
    return id ? `${activeOrganization()?.id ?? "__legacy__"}\0${id}` : undefined
  })
  const [detail, { refetch }] = createResource(detailSource, async (key): Promise<OrgRunDetailResponse | undefined> => {
    const id = key.slice(key.indexOf("\0") + 1)
    setLoadError(undefined)
    try {
      const result = await sdk.client.orgRuns.detail({ runID: id, ...routed() })
      if (result.error || !result.data) {
        setLoadError("Failed to load mission details.")
        return lastDetailKey === key ? lastDetail : undefined // kilocode_change - keep last-good on failure
      }
      lastDetail = result.data // kilocode_change
      lastDetailKey = key // kilocode_change
      return result.data
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
      return lastDetailKey === key ? lastDetail : undefined // kilocode_change - keep last-good on failure
    }
  })

  // Poll every 3s while the run is active (mirrors the Kilo Console's OrgRunDetailRoute).
  // kilocode_change - because a failed refetch now returns the SAME `lastDetail` object reference
  // (see fetcher above) rather than a new `undefined`, the resource's value doesn't change on a
  // transient failure, so this effect does not re-run and does NOT tear down the already-running
  // interval -- polling survives the failure. It still stops normally once a genuinely successful
  // poll returns a new object whose `run.status` is no longer "active" (completed/halted).
  createEffect(() => {
    // kilocode_change - SP2 Task 3: paused autonomous runs still need to observe external decisions.
    const status = detail()?.run.status
    if (status !== "active" && status !== "paused") return
    const timer = setInterval(() => void refetch(), POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Read .kilo/organization.jsonc once (client-side parse, same read path as /org-status and the
  // Builder Organization screen) — for the agent-tree section only.
  const [orgFile] = createResource(
    () => activeOrganization()?.id ?? "__legacy__",
    async (organizationID) => {
      const content =
        organizationID === "__legacy__"
          ? await sdk.client.file
              .read({ path: ORG_RELATIVE_PATH, workspace: project.workspace.current() })
              .then((result) => (!result.error && result.data?.type === "text" ? result.data.content.trim() : ""))
          : await sdk.client.organizations
              .get({ organizationID, workspace: project.workspace.current() })
              .then((result) => (!result.error && result.data?.definition ? result.data.definition.trim() : ""))
      if (!content) return undefined
      try {
        return OrgSchema.parse(parseJsonc(content))
      } catch {
        return undefined
      }
    },
  )

  // kilocode_change start - Task 8.3: run-list home. Fetches ONLY when the Cockpit was opened
  // without a runID (the run picker below) -- once a run is selected, `detail` above takes over and
  // this resource goes idle (createResource's source returns undefined whenever runID() is set).
  //
  // kilocode_change - wave-close review fix: `sdk.client.orgRuns.list` REJECTS on a network-level
  // failure (server down / connection refused / sleep-resume -- the SDK response interceptor
  // throws on a non-JSON body), which previously put this resource into Solid's errored state;
  // reading an errored resource's accessor re-throws, and `runRows`/the `Show` conditions below
  // read `runsList()`, so that re-throw would escape to the app ErrorBoundary and crash the whole
  // TUI on the run-list home. Wrapped in try/catch returning `[]`, MIRRORING the `detail` fetcher's
  // pattern above (incl. its own `runsListError` signal so the run-list home can show why it's
  // empty instead of silently looking like "no runs yet").
  const [runsListError, setRunsListError] = createSignal<string | undefined>()
  const [runsList] = createResource(
    () => (runID() ? undefined : (activeOrganization()?.id ?? "__legacy__")),
    async () => {
      setRunsListError(undefined)
      try {
        const result = await sdk.client.orgRuns.list(routed())
        if (result.error || !result.data) {
          setRunsListError("Failed to load missions.")
          return []
        }
        return result.data.runs
      } catch (err) {
        setRunsListError(err instanceof Error ? err.message : String(err))
        return []
      }
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
  // kilocode_change start - SP2 Task 3: pure autonomous-loop view-models.
  const evaluator = createMemo(() => {
    const run = detail()
    return run ? buildEvaluatorPanel(run) : undefined
  })
  const loop = createMemo(() => {
    const run = detail()
    return run ? loopGauge(run) : undefined
  })
  const card = createMemo(() => {
    const run = detail()
    return run ? conversationCard(run) : ({ kind: "none" } as const)
  })
  const completion = createMemo(() => {
    const run = detail()
    return run ? missionCompletion(run) : undefined
  })
  const organizationStats = createMemo(() => {
    const organization = orgFile()
    if (!organization) return { departments: 0, agents: 0 }
    const agents = new Set([
      organization.ceo,
      ...Object.values(organization.departments).flatMap((department) => [department.chief, ...department.workers]),
    ])
    return { departments: Object.keys(organization.departments).length, agents: agents.size }
  })
  // kilocode_change end

  // kilocode_change start - Task 8.2: gate/halt/budget notifications, fired ONCE per transition.
  // Tracks the previous poll's snapshot (per-stage status, run status, escalated) and compares it
  // to the current `detail()` on every change; `prev` stays undefined until the first snapshot is
  // recorded, so the initial load never fires a toast for state that was already true on arrival —
  // only a genuine transition (prev !== awaiting_approval -> now awaiting_approval, etc.) does. The
  // snapshot is then overwritten with the new state every time, so a transition is only ever
  // detected once (the NEXT poll's "previous" already reflects it).
  //
  // kilocode_change - wave-close review fix: this used to be a `createSignal`, which made the
  // effect below both READ (`prevSnapshot()`) and WRITE (`setPrevSnapshot(...)`) the same signal
  // inside one `createEffect` -- reading it subscribes the effect to it, and writing it (with a
  // fresh object every run) then immediately reschedules the very effect that just ran, an
  // unbounded self-retriggering loop that hangs the TUI the instant the Cockpit shows any active
  // run. Fixed by holding the previous snapshot in a PLAIN closure variable instead (mirrors
  // `context/route.tsx`'s `let previous` / `routes/session/index.tsx`'s `let processSessionID`):
  // the effect still tracks `detail()` (its real, external dependency) but no longer subscribes to
  // its own writes, since a plain `let` isn't reactive at all.
  type NotifySnapshot = { stageStatus: Record<string, string>; runStatus: string; escalated: boolean }
  let prevSnapshot: NotifySnapshot | undefined

  createEffect(() => {
    const run = detail()
    if (!run) return
    const nextStageStatus: Record<string, string> = {}
    for (const stage of run.stages) nextStageStatus[stage.stage] = stage.status

    const prev = prevSnapshot
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

    prevSnapshot = { stageStatus: nextStageStatus, runStatus: run.run.status, escalated: !!run.run.escalated }
  })
  // kilocode_change end

  // kilocode_change start - SP2 Task 5: view-owned conversation state and HTTP-only dispatch.
  const [stripMode, setStripMode] = createSignal<StripMode>("idle")
  const [stripSent, setStripSent] = createSignal<string>()
  const [planCriteria, setPlanCriteria] = createSignal<string[]>()
  let planCardKey: string | undefined
  createEffect(() => {
    const current = card()
    const next = current.kind === "plan" ? `${runID() ?? ""}:${current.stage}` : undefined
    if (next === planCardKey) return
    planCardKey = next
    setPlanCriteria(undefined)
  })
  const presentedCard = createMemo(() => {
    const current = card()
    const edited = planCriteria()
    return current.kind === "plan" && edited ? { ...current, criteria: edited } : current
  })
  const dispatch = (request: Promise<unknown>, onSuccess?: () => void) => {
    void request
      .then((result) => {
        if (result && typeof result === "object" && "error" in result && result.error) {
          throw new Error("Mission Control request returned an error")
        }
        onSuccess?.()
        void refetch()
      })
      .catch(() => {
        toast.show({ message: "Mission Control request failed.", variant: "error" })
      })
  }
  const stripDone = (label: string) => {
    setStripSent(label)
    setStripMode("sent")
  }
  const cardStage = () => {
    const current = presentedCard()
    return current.kind === "none" ? undefined : current.stage
  }

  function decide(decision: "approve" | "no-go" | "revise", note?: string, confirmation?: string) {
    const id = runID()
    if (!id) return
    dispatch(
      sdk.client.orgRuns.decision({
        runID: id,
        ...routed(),
        stage: cardStage(),
        decision,
        note,
      }),
      confirmation ? () => stripDone(confirmation) : undefined,
    )
  }

  function sendNote(raw: string) {
    const id = runID()
    if (!id) return
    const { target, text } = parseMention(raw)
    if (!text) return
    dispatch(
      sdk.client.orgRuns.note({
        runID: id,
        ...routed(),
        target_agent: target,
        text,
      }),
      () => stripDone(`Note sent to ${target}`),
    )
  }

  function approvePlan() {
    const id = runID()
    const current = presentedCard()
    const run = detail()
    if (!id || current.kind !== "plan" || !run) return
    const stages = run.stages.map((stage) => ({
      stage: stage.stage,
      objective: stage.objective?.trim() || `Complete ${stage.stage}`,
      criteria: stage.stage === current.stage ? current.criteria : (stage.criteria ?? []),
    }))
    dispatch(
      sdk.client.orgRuns.plan({ runID: id, ...routed(), stages }).then(async (result) => {
        if (result.error) throw new Error("Plan update failed")
        return sdk.client.orgRuns.decision({
          runID: id,
          ...routed(),
          stage: current.stage,
          decision: "approve",
        })
      }),
      () => stripDone("Plan approved — run is now autonomous"),
    )
  }

  function submitNote(text: string) {
    if (stripMode() === "plan-edit") {
      const criteria = text
        .split(/[;\n]/)
        .map((criterion) => criterion.trim())
        .filter(Boolean)
      if (criteria.length === 0) return
      setPlanCriteria(criteria)
      stripDone("Plan criteria updated — press a to approve")
      return
    }
    if (stripMode() === "revise-note") {
      decide("revise", text, `Revision requested: ${text}`)
      return
    }
    sendNote(text)
  }

  function cardApprove() {
    const current = presentedCard()
    if (current.kind === "plan") return approvePlan()
    if (current.kind !== "final_gate") return
    decide("approve", undefined, "Approved")
  }

  function cardNoGo() {
    if (card().kind !== "escalation") return
    decide("no-go", undefined, "No-go sent")
  }

  function cardCancel() {
    if (card().kind !== "final_gate") return
    decide("no-go", undefined, "Cancelled")
  }

  async function hardStop() {
    const id = runID()
    if (!id) return
    const reason = await DialogPrompt.show(dialog, "Stop run", {
      placeholder: "Reason for stopping",
    })
    if (reason === null) return
    const trimmed = reason.trim()
    if (!trimmed) return
    dispatch(sdk.client.orgRuns.stop({ runID: id, ...routed(), reason: trimmed }))
    toast.show({ message: "Stop request sent.", variant: "info" })
  }

  function pauseRun() {
    const id = runID()
    if (!id) return
    dispatch(
      sdk.client.orgRuns.pause({
        runID: id,
        ...routed(),
        detail: "operator pause from Mission Control",
        stage: cardStage(),
      }),
    )
    toast.show({ message: "Pause requested.", variant: "info" })
  }

  function openChat() {
    keymap.dispatchCommand("northstar.chat")
  }
  // kilocode_change end

  useBindings(() => {
    const current = presentedCard()
    const composing = stripMode() === "note" || stripMode() === "revise-note" || stripMode() === "plan-edit"
    const hasRun = !!runID()
    const hasRunControls = hasRun && !completion()
    const chatAction = !hasRun ? runRows().length === 0 : !!completion()
    const cardBindings: { key: string; cmd: string }[] = []
    if (hasRunControls && !composing) {
      if (current.kind === "plan") {
        cardBindings.push({ key: "a", cmd: "cockpit.card.approve" })
        cardBindings.push({ key: "e", cmd: "cockpit.card.edit" })
      } else if (current.kind === "escalation") {
        cardBindings.push({ key: "s", cmd: "cockpit.card.steer" })
        cardBindings.push({ key: "n", cmd: "cockpit.card.nogo" })
      } else if (current.kind === "final_gate") {
        cardBindings.push({ key: "a", cmd: "cockpit.card.approve" })
        cardBindings.push({ key: "r", cmd: "cockpit.card.revise" })
        cardBindings.push({ key: "c", cmd: "cockpit.card.cancel" })
      }
      cardBindings.push({ key: "m", cmd: "cockpit.card.message" })
    }
    const escalationClaimsS = hasRunControls && !composing && current.kind === "escalation"
    return {
      commands: [
        {
          namespace: "palette",
          name: "cockpit.chat",
          title: hasRun ? "Return to Chat" : "Start a mission",
          desc: "Open the active organization's CEO Chat",
          category: "Cockpit",
          hidden: true,
          run: openChat,
        },
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
          desc: "Stop the current run server-side",
          category: "Cockpit",
          run: () => void hardStop(),
        },
        {
          namespace: "palette",
          name: "cockpit.pause",
          title: "Pause run",
          desc: "Pause the autonomous loop",
          category: "Cockpit",
          run: () => pauseRun(),
        },
        {
          namespace: "palette",
          name: "cockpit.card.approve",
          title: "Approve",
          desc: "Approve the active plan or final gate",
          category: "Cockpit",
          hidden: true,
          run: () => cardApprove(),
        },
        {
          namespace: "palette",
          name: "cockpit.card.nogo",
          title: "No-go",
          desc: "Reject the active escalation",
          category: "Cockpit",
          hidden: true,
          run: () => cardNoGo(),
        },
        {
          namespace: "palette",
          name: "cockpit.card.revise",
          title: "Request revision",
          desc: "Ask for final-gate changes",
          category: "Cockpit",
          hidden: true,
          run: () => setStripMode("revise-note"),
        },
        {
          namespace: "palette",
          name: "cockpit.card.cancel",
          title: "Cancel run",
          desc: "Cancel at the final gate",
          category: "Cockpit",
          hidden: true,
          run: () => cardCancel(),
        },
        {
          namespace: "palette",
          name: "cockpit.card.steer",
          title: "Steer",
          desc: "Compose an escalation steering note",
          category: "Cockpit",
          hidden: true,
          run: () => setStripMode("note"),
        },
        {
          namespace: "palette",
          name: "cockpit.card.edit",
          title: "Edit plan criteria",
          desc: "Replace the active plan stage criteria",
          category: "Cockpit",
          hidden: true,
          run: () => setStripMode("plan-edit"),
        },
        {
          namespace: "palette",
          name: "cockpit.card.message",
          title: "Message an agent",
          desc: "Compose a steering note",
          category: "Cockpit",
          hidden: true,
          run: () => setStripMode("note"),
        },
      ],
      // kilocode_change - SP2 wave-close: while a textarea owns focus, plain letters (notably p/s)
      // must reach it instead of firing pause/stop; the composer itself owns escape and submit.
      bindings: composing
        ? []
        : [
            { key: "escape", cmd: "cockpit.back" },
            ...(hasRunControls
              ? [{ key: "p", cmd: "cockpit.pause" }, ...(escalationClaimsS ? [] : [{ key: "s", cmd: "cockpit.stop" }])]
              : []),
            ...(chatAction ? [{ key: "enter", cmd: "cockpit.chat" }] : []),
            ...cardBindings,
          ],
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingTop={1} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        Mission Control
      </text>

      {/* kilocode_change start - Task 8.3: run-list home (no runID -> pick a run) */}
      <Show when={!runID()}>
        <Show when={runsList.loading && !runsList()}>
          <text fg={theme.textMuted}>Loading missions...</text>
        </Show>
        {/* kilocode_change - wave-close review fix: surface a fetch failure distinctly from the
            legitimate "no runs yet" empty state (see runsListError above). */}
        <Show when={!runsList.loading && runsListError()}>
          <text fg={theme.error}>{runsListError()}</text>
        </Show>
        <Show when={!runsList.loading && !runsListError() && runsList() && runRows().length === 0}>
          <MissionEmptyState
            organizationName={activeOrganization()?.name ?? "Organization"}
            departments={organizationStats().departments}
            agents={organizationStats().agents}
            onStart={openChat}
          />
        </Show>
        <Show when={runRows().length > 0}>
          <DialogSelect
            title="Missions"
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
          <box flexDirection="row" flexShrink={0} gap={2}>
            <text fg={theme.text}>{detail()!.run.idea}</text>
            <text fg={theme.textMuted}>{detail()!.run.status}</text>
            <text fg={theme.textMuted}>
              {formatCost(typeof detail()!.totalCost === "number" ? (detail()!.totalCost as number) : 0)}
            </text>
            {/* kilocode_change - SP2 Task 5: contextual pause / stop controls. */}
            <Show when={!completion()}>
              <text fg={theme.textMuted}>p: pause · s: stop</text>
            </Show>
          </box>

          <Show when={completion()}>{(done) => <MissionCompletionState value={done()} onReturn={openChat} />}</Show>

          {/* kilocode_change start - SP2 wave-close: keep the action strip visible at normal
              terminal heights; only the observational dashboard below it scrolls. */}
          <MissionStrip
            card={presentedCard()}
            mode={stripMode()}
            sent={stripSent()}
            onSubmitNote={submitNote}
            onCancelNote={() => setStripMode("idle")}
          />
          {/* kilocode_change end */}

          {/* kilocode_change - Task 8.2: budget gauge moved into the header (right under the run
              summary row, above Pipeline/Agent-tree/Activity) so it's always visible without
              scrolling, per the EPIC 8 plan's "always-visible budget" requirement. */}
          <box flexDirection="column" flexShrink={0} border={["top"]} borderColor={theme.border} paddingTop={1}>
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

          <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: false }}>
            <box flexDirection="column" gap={1}>
              {/* kilocode_change start - SP2 Task 3: Mission Control panels */}
              <Show when={loop()}>{(value) => <MissionLoopGauge gauge={value()} />}</Show>
              <Show when={evaluator()}>{(value) => <MissionEvaluatorPanel panel={value()} />}</Show>
              {/* kilocode_change end */}

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
                      <Show when={stage.annotation}>
                        <text fg={theme.warning}>{stage.annotation}</text>
                      </Show>
                    </box>
                  )}
                </For>
              </box>

              {/* Agent tree */}
              <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
                <text attributes={TextAttributes.BOLD} fg={theme.text}>
                  Agent tree
                </text>
                <Show when={tree()} fallback={<text fg={theme.textMuted}>Organization definition unavailable.</text>}>
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
              <box flexDirection="column" border={["top"]} borderColor={theme.border} paddingTop={1}>
                <text attributes={TextAttributes.BOLD} fg={theme.text}>
                  Activity
                </text>
                <Show when={audit().length === 0}>
                  <text fg={theme.textMuted}>No approval activity recorded yet.</text>
                </Show>
                <For each={audit()}>
                  {(entry) => (
                    <text fg={theme.textMuted}>
                      {timestamp(entry.ts)} {entry.stage} {entry.decision} {entry.note ?? "—"}
                    </text>
                  )}
                </For>
              </box>
            </box>
          </scrollbox>
        </box>
      </Show>
    </box>
  )
}
