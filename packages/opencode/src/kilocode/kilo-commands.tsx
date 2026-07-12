/**
 * Kilo Gateway Commands for TUI
 *
 * Provides /profile and /teams commands that are only visible when connected to Kilo Gateway,
 * plus /org-status and /org-builder (org discoverability — Task 7.1, EPIC 7) which work on any
 * project regardless of Kilo Gateway connection.
 */

import { createMemo } from "solid-js"
import { parse as parseJsonc } from "jsonc-parser"
import { useBindings } from "@tui/keymap"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { DialogAlert } from "@tui/ui/dialog-alert"
import type { Organization } from "@kilocode/kilo-gateway"
import type { ClawStatus } from "./claw/types.js"
import { DialogKiloTeamSelect } from "./components/dialog-kilo-team-select.js"
import { DialogKiloProfile } from "./components/dialog-kilo-profile.js"
import { DialogClawSetup } from "./components/dialog-claw-setup.js"
import { DialogClawUpgrade } from "./components/dialog-claw-upgrade.js"
import { DialogIndexing } from "./components/dialog-indexing.js"
import { indexingEnabled } from "./indexing-feature"
import { refreshBalance } from "./balance-refresh"
import { OrgSchema } from "./organization/schema"

// kilocode_change start - Task 7.1 (EPIC 7): /org-status reads .kilo/organization.jsonc the exact
// same way the Builder Organization screen does (organization-screen.tsx) — the generic, already-
// public `file.read` endpoint (not org-specific), parsed client-side with `jsonc-parser` +
// `OrgSchema.parse`, then validated with the same pure `OrgSchema.validate`/`crossCheck` the server
// uses. This is NOT a new endpoint. Run *state* (OrgState.list/status) lives under
// `.kilo/org/runs/**` on the server's filesystem and has no TUI-reachable read path today (no SDK/
// HTTP endpoint exposes it) — the dialog says so honestly rather than faking a run list.
const ORG_RELATIVE_PATH = ".kilo/organization.jsonc"
// kilocode_change end

// These types are OpenCode-internal and imported at runtime
type UseSDK = any
type SDK = any

/**
 * Register all Kilo Gateway commands
 * Call this from a component inside the TUI app
 *
 * @param useSDK - OpenCode's useSDK hook (passed from TUI context)
 */
export function registerKiloCommands(useSDK: () => UseSDK) {
  const sync = useSync()
  const route = useRoute()
  const project = useProject()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  // Only show Kilo commands when connected to Kilo Gateway
  const isKiloConnected = createMemo(() => {
    return sync.data.provider_next.connected.includes("kilo")
  })
  const indexing = createMemo(() => indexingEnabled(sync.data.config))

  useBindings(() => ({
    commands: [
      // /builder command
      {
        name: "builder.open",
        title: "Open Builder",
        desc: "Open the Builder (Models / Agents / Organization)",
        category: "Builder",
        slashName: "builder",
        run: () => {
          route.navigate({ type: "builder" })
          dialog.clear()
        },
      },

      // kilocode_change start - Task 7.1 (EPIC 7): /org-status and /org-builder (org
      // discoverability from the composer palette). See the ORG_RELATIVE_PATH comment above for
      // the read-path rationale.
      {
        name: "org.status",
        title: "Org Status",
        desc: "Show the project's organization chart and validation from .kilo/organization.jsonc",
        category: "Org",
        slashName: "org-status",
        run: async () => {
          try {
            const fileRes = await sdk.client.file.read({
              path: ORG_RELATIVE_PATH,
              workspace: project.workspace.current(),
            })
            const content =
              !fileRes.error && fileRes.data?.type === "text" ? fileRes.data.content.trim() : ""
            if (!content) {
              dialog.replace(() => (
                <DialogAlert
                  title="Organization Status"
                  message={`No ${ORG_RELATIVE_PATH} found in this project.\nOpen the Builder (/org-builder or /builder) to create one, or run "northstar org init".`}
                />
              ))
              return
            }

            let org: OrgSchema.Organization
            try {
              org = OrgSchema.parse(parseJsonc(content))
            } catch (err) {
              dialog.replace(() => (
                <DialogAlert
                  title="Organization Status"
                  message={`Failed to parse ${ORG_RELATIVE_PATH}:\n${err instanceof Error ? err.message : String(err)}`}
                />
              ))
              return
            }

            const agentsView = Object.fromEntries(
              sync.data.agent.map((agent) => [agent.name, { mode: agent.mode, subordinates: agent.subordinates }]),
            )
            const issues = [...OrgSchema.validate(org), ...OrgSchema.crossCheck(org, agentsView)]
            const agentCount = new Set([
              org.ceo,
              ...Object.values(org.departments).flatMap((dept) => [dept.chief, ...dept.workers]),
              ...org.shared,
            ]).size

            const lines = [
              `ceo: ${org.ceo}`,
              `departments: ${Object.keys(org.departments).length}  pipeline stages: ${org.pipeline.length}  agents: ${agentCount}`,
              "",
              issues.length ? `issues (${issues.length}):` : "no validation issues",
              ...issues.map((issue) => `- ${issue}`),
              "",
              "Run status/list isn't reachable from the composer yet — ask the CEO in chat (org_status) or open the Builder (/org-builder) for the full editor.",
            ]
            dialog.replace(() => <DialogAlert title="Organization Status" message={lines.join("\n")} />)
          } catch (error) {
            dialog.replace(() => (
              <DialogAlert title="Error" message={`Failed to read organization status: ${error}`} />
            ))
          }
        },
      },

      // /org-builder command — opens the Builder directly on the Organization section (vs.
      // /builder, which defaults to Models).
      {
        name: "org.builder",
        title: "Open Org Builder",
        desc: "Open the Builder on the Organization section",
        category: "Org",
        slashName: "org-builder",
        run: () => {
          route.navigate({ type: "builder", section: "organization" })
          dialog.clear()
        },
      },

      // /cockpit command (Task 8.1b, EPIC 8) — opens the Cockpit dashboard. No runID yet (8.3 adds
      // a run-list when absent); the view shows "no run selected" until then.
      {
        name: "cockpit.open",
        title: "Open Cockpit",
        desc: "Open the org-run Cockpit dashboard",
        category: "Org",
        slashName: "cockpit",
        run: () => {
          route.navigate({ type: "cockpit" })
          dialog.clear()
        },
      },
      // kilocode_change end

      // /kiloclaw command
      {
        name: "kilo.claw",
        title: "KiloClaw",
        desc: "Open KiloClaw chat & dashboard",
        category: "Kilo",
        slashName: "kiloclaw",
        slashAliases: ["claw"],
        enabled: isKiloConnected(),
        hidden: !isKiloConnected(),
        run: async () => {
          // Fetch profile (for org context) and instance status in parallel
          const [profileRes, res] = await Promise.all([
            sdk.client.kilo.profile().catch(() => null),
            sdk.client.kilo.claw.status().catch(() => null),
          ])
          const orgId = profileRes?.data?.currentOrgId ?? null
          const status = res?.data as ClawStatus | undefined

          // No instance provisioned
          if (!status || !status.userId || res.error) {
            dialog.replace(() => <DialogClawSetup orgId={orgId} />)
            return
          }

          // Instance exists — check for chat credentials
          const creds = await sdk.client.kilo.claw.chatCredentials().catch(() => null)

          if (!creds?.data || creds.error) {
            // Instance exists but no chat credentials — needs upgrade
            dialog.replace(() => <DialogClawUpgrade orgId={orgId} />)
            return
          }

          // Everything ready — navigate to full-screen chat view
          route.navigate({ type: "kiloclaw" })
          dialog.clear()
        },
      },

      // /remote command
      {
        name: "remote.toggle",
        title: "Toggle remote",
        desc: "Enable or disable remote session relay",
        category: "Kilo",
        slashName: "remote",
        enabled: isKiloConnected(),
        hidden: !isKiloConnected(),
        run: async () => {
          try {
            const current = await sdk.client.remote.status()

            if (current.error || !current.data) {
              dialog.replace(() => <DialogAlert title="Error" message="Failed to fetch remote status." />)
              return
            }

            if (current.data.enabled) {
              await sdk.client.remote.disable()
              toast.show({ message: "Remote disabled", variant: "success" })
            } else {
              const result = await sdk.client.remote.enable()
              if (result.error) {
                const err = result.error as { error?: string }
                const msg = err?.error ?? "Failed to enable remote."
                dialog.replace(() => <DialogAlert title="Error" message={msg} />)
                return
              }
              toast.show({ message: "Remote enabled", variant: "success" })
            }

            dialog.clear()
          } catch (error) {
            dialog.replace(() => <DialogAlert title="Error" message={`Failed to toggle remote: ${error}`} />)
          }
        },
      },

      // /profile command
      {
        name: "kilo.profile",
        title: "Profile",
        desc: "View your Kilo Gateway profile",
        category: "Kilo",
        slashName: "profile",
        slashAliases: ["me", "whoami"],
        enabled: isKiloConnected(),
        hidden: !isKiloConnected(),
        run: async () => {
          try {
            // Fetch profile and balance using server endpoint
            const response = await sdk.client.kilo.profile()

            if (response.error || !response.data) {
              dialog.replace(() => (
                <DialogAlert
                  title="Error"
                  message="Failed to fetch profile. Please ensure you're authenticated with Kilo Gateway."
                />
              ))
              return
            }

            const { profile, balance, currentOrgId } = response.data

            // Show profile dialog with clickable usage link
            dialog.replace(() => <DialogKiloProfile profile={profile} balance={balance} currentOrgId={currentOrgId} />)
          } catch (error) {
            dialog.replace(() => <DialogAlert title="Error" message={`Failed to fetch profile: ${error}`} />)
          }
        },
      },

      ...(indexing()
        ? [
            {
              name: "kilo.indexing",
              title: "Indexing",
              desc: "Configure codebase indexing",
              category: "Kilo",
              slashName: "indexing",
              slashAliases: ["index", "embedding"],
              run: () => {
                dialog.replace(() => <DialogIndexing useSDK={useSDK} />)
              },
            },
          ]
        : []),

      // /teams command
      {
        name: "kilo.teams",
        title: "Teams",
        desc: "Switch between Kilo Gateway teams",
        category: "Kilo",
        slashName: "teams",
        slashAliases: ["team", "org", "orgs"],
        enabled: isKiloConnected(),
        hidden: !isKiloConnected(),
        run: async () => {
          try {
            // Fetch profile to get organizations
            const response = await sdk.client.kilo.profile()

            if (response.error || !response.data) {
              dialog.replace(() => (
                <DialogAlert
                  title="Error"
                  message="Failed to fetch teams. Please ensure you're authenticated with Kilo Gateway."
                />
              ))
              return
            }

            const { profile, currentOrgId } = response.data

            if (!profile.organizations || profile.organizations.length === 0) {
              dialog.replace(() => (
                <DialogAlert
                  title="No Teams Available"
                  message="You're not a member of any teams.\nVisit https://app.kilo.ai to create or join a team."
                />
              ))
              return
            }

            // Show team selection dialog
            dialog.replace(() => (
              <DialogKiloTeamSelect
                organizations={profile.organizations!}
                currentOrgId={currentOrgId}
                hasPersonalAccount={profile.hasPersonalAccount !== false}
                onSelect={async (orgId) => {
                  try {
                    // Switch to team immediately using server endpoint
                    const result = await sdk.client.kilo.organization.set({
                      organizationId: orgId,
                    })
                    if (result.error) {
                      toast.show({
                        message: "Failed to switch team",
                        variant: "error",
                      })
                      dialog.clear()
                      return
                    }

                    // Refresh provider state to reload models with new organization context
                    await sdk.client.instance.dispose()
                    await sync.bootstrap()

                    // Update the sidebar balance immediately for the newly selected account
                    refreshBalance()

                    // Show success toast
                    const teamName = orgId
                      ? profile.organizations!.find((o: Organization) => o.id === orgId)?.name
                      : "Personal"

                    toast.show({
                      message: `Switched to: ${teamName}`,
                      variant: "success",
                    })

                    // Close dialog
                    dialog.clear()
                  } catch (error) {
                    if (error instanceof DOMException && error.name === "AbortError") return
                    toast.show({
                      message: "Failed to switch team",
                      variant: "error",
                    })
                    dialog.clear()
                  }
                }}
              />
            ))
          } catch (error) {
            dialog.replace(() => <DialogAlert title="Error" message={`Failed to fetch teams: ${error}`} />)
          }
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  }))
}
