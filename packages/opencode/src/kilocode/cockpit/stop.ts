// kilocode_change - new file
/**
 * Task 8.2 (EPIC 8 / TUI Cockpit): pure hard-stop message builder.
 *
 * `org_stop` is a CEO-scoped tool with no HTTP path (organization/tools.ts), so the Cockpit
 * cannot call it directly — and MUST NOT call `OrgRunner.stop` itself, since the Cockpit is a
 * READ-ONLY thin client over run state (see the EPIC 8 plan's determinism/security invariants).
 * Instead the hard-stop control sends this string as a plain CEO-instruction chat message via
 * `sdk.client.session.prompt` — the SAME send mechanism the 7.4 gate card uses (see
 * `routes/session/gate-card.tsx`'s `send` + `gate-card.ts`'s `gateMessage`) — into the CEO's own
 * session. `ceo.md`'s protocol step 8 recognizes a "stop run <id>: <reason>" message and turns it
 * into `org_stop(run_id, reason)`.
 *
 * Kept pure and side-effect-free (no network, no SDK import) so it's unit-testable without
 * rendering the Cockpit view — see `view.tsx` for where this is wired into the stop control.
 */
export function stopMessage(runID: string | undefined, reason: string): string {
  return `stop run ${runID ?? "the current run"}: ${reason}`
}
