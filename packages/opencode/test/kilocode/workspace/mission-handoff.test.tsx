/** @jsxImportSource @opentui/solid */
// kilocode_change - autonomous Chat-to-Mission handoff
import { expect, test } from "bun:test"
import { OrgWorkspaceEvent } from "../../../src/kilocode/organization/events"
import { missionRouteForEvent } from "../../../src/kilocode/workspace/shell"

test("approved autonomous plan opens its Mission run for the active organization", () => {
  const event = {
    type: OrgWorkspaceEvent.AutonomousStarted.type,
    properties: { organizationID: "alpha", runID: "run_1", sessionID: "ses_ceo" },
  }

  expect(missionRouteForEvent(event, "alpha")).toEqual({
    type: "cockpit",
    runID: "run_1",
    sessionID: "ses_ceo",
  })
})

test("autonomous events from another organization do not change the route", () => {
  expect(
    missionRouteForEvent(
      {
        type: "organization.autonomous.started",
        properties: { organizationID: "beta", runID: "run_2", sessionID: "ses_beta" },
      },
      "alpha",
    ),
  ).toBeUndefined()
})
