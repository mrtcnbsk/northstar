// kilocode_change - active Northstar project organization state for TUI consumers
import { onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "@tui/context/helper"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"

export type WorkspaceOrganization = {
  id: string
  name: string
  layout: "legacy" | "managed"
  root: string
  valid: boolean
  issues: readonly string[]
  draft: boolean
}

export type WorkspaceRegistry = {
  active?: string
  organizations: readonly WorkspaceOrganization[]
  drafts: readonly WorkspaceOrganization[]
}

export const { use: useWorkspace, provider: WorkspaceProvider } = createSimpleContext({
  name: "NorthstarWorkspace",
  init: () => {
    const sdk = useSDK()
    const sync = useSync()
    const project = useProject()
    const [store, setStore] = createStore<{
      status: "loading" | "ready" | "switching" | "error"
      active?: string
      organizations: WorkspaceOrganization[]
      drafts: WorkspaceOrganization[]
      runCounts: Record<string, { active: number; paused: number }>
      error?: string
      switchError?: string
      dirtySetup: boolean
    }>({ status: "loading", organizations: [], drafts: [], runCounts: {}, dirtySetup: false })

    const routed = () => ({ workspace: project.workspace.current() })

    async function reload() {
      try {
        const response = await sdk.client.organizations.list(routed(), { throwOnError: true })
        const data = response.data
        if (!data) throw new Error("Northstar organization registry is unavailable")
        const counts = await Promise.all(
          data.organizations.map(async (organization) => {
            const response = await sdk.client.orgRuns
              .list({ organizationID: organization.id, ...routed() }, { throwOnError: true })
              .catch(() => undefined)
            const runs = response?.data?.runs ?? []
            return [
              organization.id,
              {
                active: runs.filter((run) => run.status === "active").length,
                paused: runs.filter((run) => run.status === "paused").length,
              },
            ] as const
          }),
        )
        setStore("active", data.active)
        setStore("organizations", reconcile(data.organizations.map((item) => ({ ...item, issues: [...item.issues] }))))
        setStore("drafts", reconcile(data.drafts.map((item) => ({ ...item, issues: [...item.issues] }))))
        setStore("runCounts", reconcile(Object.fromEntries(counts)))
        setStore("error", undefined)
        setStore("status", "ready")
      } catch (error) {
        setStore("error", error instanceof Error ? error.message : String(error))
        setStore("status", "error")
      }
    }

    async function select(organizationID: string) {
      const previous = store.active
      setStore("status", "switching")
      setStore("switchError", undefined)
      try {
        await sdk.client.organizations.select({ organizationID, ...routed() }, { throwOnError: true })
        await sdk.client.instance.dispose(routed())
        await sync.bootstrap()
        await reload()
      } catch (error) {
        if (previous && previous !== organizationID) {
          await sdk.client.organizations.select({ organizationID: previous, ...routed() }).catch(() => undefined)
        }
        setStore("active", previous)
        setStore("switchError", error instanceof Error ? error.message : String(error))
        setStore("status", "ready")
        throw error
      }
    }

    onMount(() => void reload())

    return {
      data: store,
      active() {
        return store.organizations.find((organization) => organization.id === store.active)
      },
      reload,
      select,
      setDirtySetup(value: boolean) {
        setStore("dirtySetup", value)
      },
    }
  },
})
