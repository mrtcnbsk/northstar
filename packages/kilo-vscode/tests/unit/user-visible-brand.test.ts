import { describe, expect, test } from "bun:test"
import path from "node:path"
import { scanVisibleBrand } from "../../../../script/user-visible-brand"

const root = path.resolve(import.meta.dir, "../..")
const repo = path.resolve(root, "../..")

async function sources() {
  const found = [
    { file: "packages/kilo-vscode/package.json", text: await Bun.file(path.join(root, "package.json")).text() },
  ]
  for (const pattern of ["src/**/*.{ts,tsx}", "webview-ui/src/**/*.{ts,tsx}"]) {
    const glob = new Bun.Glob(pattern)
    for await (const file of glob.scan({ cwd: root, absolute: true })) {
      found.push({ file: path.relative(repo, file), text: await Bun.file(file).text() })
    }
  }
  return found
}

describe("Northstar VS Code presentation", () => {
  test("shipped manifest, extension, and webview source have no old product copy", async () => {
    expect(scanVisibleBrand(await sources())).toEqual([])
  })
})
