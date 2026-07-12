import { describe, expect, test } from "bun:test"
import path from "node:path"
import { scanVisibleBrand } from "../../../../script/user-visible-brand"

const repo = path.resolve(import.meta.dir, "../../../..")
const root = path.join(repo, "packages/kilo-jetbrains")

async function sources() {
  const found: { file: string; text: string }[] = [
    {
      file: "packages/kilo-jetbrains/build.gradle.kts",
      text: await Bun.file(path.join(root, "build.gradle.kts")).text(),
    },
  ]
  for (const base of ["frontend/src/main", "src/main/resources"]) {
    const glob = new Bun.Glob(`${base}/**/*.{kt,xml,properties}`)
    for await (const file of glob.scan({ cwd: root, absolute: true })) {
      found.push({ file: path.relative(repo, file), text: await Bun.file(file).text() })
    }
  }
  return found
}

describe("Northstar JetBrains presentation", () => {
  test("shipped metadata, Kotlin UI, and resource values have no old product copy", async () => {
    expect(scanVisibleBrand(await sources())).toEqual([])
  })
})
