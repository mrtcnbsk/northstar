import { describe, expect, test } from "bun:test"
import path from "path"

const root = path.join(__dirname, "..", "..")

describe("Northstar OAuth branding", () => {
  test("Codex OAuth browser flow keeps protocol IDs and presents Northstar", async () => {
    const src = await Bun.file(path.join(root, "src", "plugin", "openai", "codex.ts")).text()

    expect(src).toContain('originator: "kilo"')
    expect(src).toContain('"User-Agent": `kilo/${InstallationVersion}`')
    expect(src).toContain("return to Northstar")
    expect(src).not.toContain('originator: "opencode"')
    expect(src).not.toContain("return to Kilo")
    expect(src).not.toContain("return to OpenCode")
  })

  test("MCP OAuth callback page presents Northstar", async () => {
    const src = await Bun.file(path.join(root, "src", "mcp", "oauth-callback.ts")).text()

    expect(src).toContain("return to Northstar")
    expect(src).not.toContain("return to Kilo")
    expect(src).not.toContain("return to OpenCode")
  })
})
