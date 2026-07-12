import { describe, expect, test } from "bun:test"
import { OrgIrreversible } from "../../../src/kilocode/organization/irreversible"

describe("OrgIrreversible", () => {
  test("classifies author-declared and human-gated stages as irreversible", () => {
    expect(OrgIrreversible.stage({ stage: "submit", irreversible: true })).toBe(true)
    expect(OrgIrreversible.stage({ stage: "release", gate: "human" })).toBe(true)
    expect(OrgIrreversible.stage({ stage: "build" })).toBe(false)
  })

  test("classifies known external or destructive tool IDs and only exact IDs", () => {
    for (const tool of ["asc_submit", "npm_publish", "release_publish", "payment_charge", "permission_update", "acl_update", "hard_delete"]) {
      expect(OrgIrreversible.tool(tool)).toBe(true)
    }
    expect(OrgIrreversible.tool("asc_status")).toBe(false)
    expect(OrgIrreversible.tool("delete_preview")).toBe(false)
    expect(OrgIrreversible.tool("publish_report_draft")).toBe(false)
  })

  test("classifies a stage when any recorded tool is denylisted", () => {
    expect(OrgIrreversible.touched(["xcode_test", "asc_submit"])).toBe(true)
    expect(OrgIrreversible.touched(["xcode_test", "asc_status"])).toBe(false)
  })
})
