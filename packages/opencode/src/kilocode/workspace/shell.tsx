// kilocode_change - persistent Northstar workspace shell
import { Show, type JSX } from "solid-js"
import { useRoute } from "@tui/context/route"
import { WorkspaceHeader } from "./header"

export function WorkspaceShell(props: { children?: JSX.Element }) {
  const route = useRoute()
  const visible = () => ["northstar", "setup", "home", "session", "cockpit"].includes(route.data.type)
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
