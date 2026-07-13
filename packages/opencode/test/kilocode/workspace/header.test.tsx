/** @jsxImportSource @opentui/solid */
// kilocode_change - Northstar workspace navigation bindings
import { expect, test } from "bun:test"
import { CommandMap, Definitions } from "../../../src/cli/cmd/tui/config/keybind"

test("lowercase leader navigation and uppercase displaced commands remain independent", () => {
  expect(Definitions.northstar_setup.default).toBe("<leader>s")
  expect(Definitions.northstar_chat.default).toBe("<leader>c")
  expect(Definitions.northstar_mission.default).toBe("<leader>m")
  expect(Definitions.northstar_organization.default).toBe("<leader>o")
  expect(CommandMap.northstar_mission).toBe("northstar.mission")

  expect(Definitions.status_view.default).toBe("<leader>S")
  expect(Definitions.session_compact.default).toBe("<leader>C")
  expect(Definitions.model_list.default).toBe("<leader>M")
})
