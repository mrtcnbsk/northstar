// kilocode_change - new file
import { test, expect } from "bun:test"
import path from "path"

test("bin/northstar parses", async () => {
  const file = Bun.file(path.join(import.meta.dir, "..", "..", "bin", "northstar"))
  const code = (await file.text()).replace(/^#![^\n]*\n/, "")
  expect(() => new Function(code)).not.toThrow()
  expect(code).toContain("Northstar CLI")
  expect(code).not.toContain("Kilo CLI")
})
