// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import path from "path"
import { scanVisibleBrand, type BrandSource } from "../../../../script/user-visible-brand"

const root = path.join(__dirname, "..", "..")

async function sources() {
  const glob = new Bun.Glob("src/**/*.{ts,tsx,txt,md}")
  const found: BrandSource[] = []
  for await (const file of glob.scan({ cwd: root, onlyFiles: true })) {
    found.push({ file: `packages/opencode/${file}`, text: await Bun.file(path.join(root, file)).text() })
  }
  return found
}

describe("Northstar CLI/TUI presentation", () => {
  test("shipped source has no old product copy or executable examples", async () => {
    expect(await sources().then(scanVisibleBrand)).toEqual([])
  })

  test("entrypoint presents the northstar executable", async () => {
    const source = await Bun.file(path.join(root, "src/index.ts")).text()
    expect(source).toContain('.scriptName("northstar")')
  })
})
