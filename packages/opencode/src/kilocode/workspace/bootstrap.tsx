// kilocode_change - first-launch and active-organization startup routing
import { createEffect, Show } from "solid-js"
import { useRoute, type Route } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"
import { useWorkspace, type WorkspaceRegistry } from "./context"

export function decideWorkspaceRoute(registry: WorkspaceRegistry): Route {
  const active = registry.organizations.find((organization) => organization.id === registry.active)
  if (active) return active.valid ? { type: "cockpit" } : { type: "setup", organizationID: active.id, repair: true }
  const draft = registry.drafts[0]
  if (draft) return { type: "setup", organizationID: draft.id }
  return { type: "setup" }
}

export function WorkspaceBootstrap() {
  const workspace = useWorkspace()
  const route = useRoute()
  const { theme } = useTheme()

  createEffect(() => {
    if (workspace.data.status !== "ready") return
    if (route.data.type !== "northstar") return
    route.navigate(
      decideWorkspaceRoute({
        active: workspace.data.active,
        organizations: workspace.data.organizations,
        drafts: workspace.data.drafts,
      }),
    )
  })

  return (
    <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column" gap={1}>
      <text fg={theme.primary}>NORTHSTAR</text>
      <Show
        when={workspace.data.status === "error"}
        fallback={<text fg={theme.textMuted}>Loading your organization...</text>}
      >
        <text fg={theme.error}>Could not load organizations: {workspace.data.error}</text>
        <text fg={theme.textMuted}>Open Setup to repair the project-local registry.</text>
      </Show>
    </box>
  )
}
