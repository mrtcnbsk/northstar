// kilocode_change - typed project-organization lifecycle events
import { Schema } from "effect"
import { BusEvent } from "@/bus/bus-event"

const RunEvent = Schema.Struct({
  organizationID: Schema.String,
  runID: Schema.String,
  sessionID: Schema.String,
})

export const OrgWorkspaceEvent = {
  RunStarted: BusEvent.define("organization.run.started", RunEvent),
  AutonomousStarted: BusEvent.define("organization.autonomous.started", RunEvent),
}
