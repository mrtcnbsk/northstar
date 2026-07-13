/** @jsxImportSource @opentui/solid */
// kilocode_change - organization-bound Chat selection
import { expect, test } from "bun:test"
import { newestOrganizationSession, organizationCEO } from "../../../src/kilocode/workspace/header"

test("Chat opens the newest root session for the active organization", () => {
  const sessions = [
    { id: "alpha-old", time: { updated: 1 }, metadata: { northstarOrganizationID: "alpha" } },
    { id: "beta-new", time: { updated: 9 }, metadata: { northstarOrganizationID: "beta" } },
    { id: "alpha-new", time: { updated: 5 }, metadata: { northstarOrganizationID: "alpha" } },
    { id: "child", parentID: "alpha-new", time: { updated: 10 }, metadata: { northstarOrganizationID: "alpha" } },
  ]
  expect(newestOrganizationSession(sessions, "alpha", false)?.id).toBe("alpha-new")
})

test("a new Chat defaults to the organization CEO", () => {
  const agents = [
    { name: "code", mode: "primary" },
    { name: "ceo", mode: "primary", source: "organization" },
    { name: "lead", mode: "subagent", source: "organization" },
  ]
  expect(organizationCEO(agents)?.name).toBe("ceo")
})
