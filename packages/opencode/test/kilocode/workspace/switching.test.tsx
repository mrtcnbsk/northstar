/** @jsxImportSource @opentui/solid */
// kilocode_change - guarded organization switching behavior
import { expect, test } from "bun:test"
import { performOrganizationSwitch } from "../../../src/kilocode/workspace/header"

test("switching selects, refreshes, and opens Mission", async () => {
  const calls: string[] = []
  const result = await performOrganizationSwitch({
    organizationID: "beta",
    dirty: false,
    confirmDiscard: async () => true,
    select: async (id) => calls.push(`select:${id}`),
    openMission: () => calls.push("mission"),
  })
  expect(result).toBe(true)
  expect(calls).toEqual(["select:beta", "mission"])
})

test("unsaved Setup changes block an immediate switch when discard is declined", async () => {
  const calls: string[] = []
  const result = await performOrganizationSwitch({
    organizationID: "beta",
    dirty: true,
    confirmDiscard: async () => false,
    select: async (id) => calls.push(`select:${id}`),
    openMission: () => calls.push("mission"),
  })
  expect(result).toBe(false)
  expect(calls).toEqual([])
})

test("a failed switch retains the current route and exposes the error", async () => {
  const calls: string[] = []
  await expect(
    performOrganizationSwitch({
      organizationID: "beta",
      dirty: false,
      confirmDiscard: async () => true,
      select: async () => {
        throw new Error("registry unavailable")
      },
      openMission: () => calls.push("mission"),
    }),
  ).rejects.toThrow("registry unavailable")
  expect(calls).toEqual([])
})
