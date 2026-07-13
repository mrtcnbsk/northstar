/** @jsxImportSource @opentui/solid */
// kilocode_change - Northstar workspace startup routing
import { describe, expect, test } from "bun:test"
import { decideWorkspaceRoute } from "../../../src/kilocode/workspace/bootstrap"

const organization = (id: string, valid = true) => ({
  id,
  name: id === "studio" ? "Product Studio" : id,
  layout: "managed" as const,
  root: `organizations/${id}`,
  valid,
  issues: valid ? [] : ["broken hierarchy"],
  draft: false,
})

describe("Workspace bootstrap", () => {
  test("no organization routes to Setup", () => {
    expect(decideWorkspaceRoute({ organizations: [], drafts: [] })).toEqual({ type: "setup" })
  })

  test("an unpublished draft resumes in Setup", () => {
    expect(decideWorkspaceRoute({ organizations: [], drafts: [{ ...organization("studio"), draft: true }] })).toEqual({
      type: "setup",
      organizationID: "studio",
    })
  })

  test("a valid active organization routes directly to Mission", () => {
    expect(decideWorkspaceRoute({ active: "studio", organizations: [organization("studio")], drafts: [] })).toEqual({
      type: "cockpit",
    })
  })

  test("an invalid active organization routes to repair Setup", () => {
    expect(
      decideWorkspaceRoute({ active: "studio", organizations: [organization("studio", false)], drafts: [] }),
    ).toEqual({ type: "setup", organizationID: "studio", repair: true })
  })
})
