// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

describe("/mission command", () => {
  test("opens the Mission Control cockpit route", () => {
    const source = readFileSync(path.join(__dirname, "../../../src/kilocode/kilo-commands.tsx"), "utf8")
    expect(source).toContain('slashName: "mission"')
    expect(source).toMatch(/route\.navigate\(\{\s*type:\s*"cockpit"/)
  })
})
