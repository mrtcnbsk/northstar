// kilocode_change - connects guided Setup completion and dirty state to the workspace shell
import { useRoute } from "@tui/context/route"
import { SetupView } from "../setup/view"
import { useWorkspace } from "./context"

export function WorkspaceSetupRoute() {
  const route = useRoute()
  const workspace = useWorkspace()
  const data = () => (route.data.type === "setup" ? route.data : { type: "setup" as const })
  return (
    <SetupView
      organizationID={data().organizationID}
      mode={data().repair ? "repair" : undefined}
      onDirtyChange={workspace.setDirtySetup}
      onPublished={async () => {
        workspace.setDirtySetup(false)
        await workspace.reload()
        route.navigate({ type: "cockpit" })
      }}
    />
  )
}
