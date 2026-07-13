// kilocode_change - persistent Northstar workspace shell
import { onCleanup, onMount, Show, type JSX } from "solid-js"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { WorkspaceHeader } from "./header"
import { useWorkspace } from "./context"
import { OrgWorkspaceEvent } from "../organization/events"

type WorkspaceEvent = { type: string; properties?: unknown }

export function missionRouteForEvent(event: WorkspaceEvent, activeOrganizationID: string | undefined) {
  if (event.type !== OrgWorkspaceEvent.AutonomousStarted.type) return
  if (!event.properties || typeof event.properties !== "object") return
  const properties = event.properties as Record<string, unknown>
  if (
    properties.organizationID !== activeOrganizationID ||
    typeof properties.runID !== "string" ||
    typeof properties.sessionID !== "string"
  )
    return
  return { type: "cockpit" as const, runID: properties.runID, sessionID: properties.sessionID }
}

export function WorkspaceShell(props: { children?: JSX.Element }) {
  const route = useRoute()
  const sdk = useSDK()
  const workspace = useWorkspace()
  const visible = () => ["northstar", "setup", "home", "session", "cockpit"].includes(route.data.type)

  onMount(() => {
    const unsubscribe = sdk.event.on("event", (event) => {
      const next = missionRouteForEvent(event.payload as WorkspaceEvent, workspace.active()?.id)
      if (next) route.navigate(next)
    })
    onCleanup(unsubscribe)
  })

  return (
    <Show when={visible()} fallback={props.children}>
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <WorkspaceHeader />
        <box flexDirection="column" flexGrow={1} minHeight={0}>
          {props.children}
        </box>
      </box>
    </Show>
  )
}
