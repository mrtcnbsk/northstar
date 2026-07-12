import { describe, expect, test } from "bun:test"
import path from "node:path"
import { scanVisibleBrand } from "../../../script/user-visible-brand"
import { ACCOUNT_NAME, BRAND_NAME, CLI_NAME, CONSOLE_NAME, GATEWAY_NAME } from "./brand"

async function sources() {
  const root = path.join(import.meta.dir)
  const glob = new Bun.Glob("**/*.{ts,tsx}")
  const found: { file: string; text: string }[] = []
  for await (const file of glob.scan({ cwd: root, absolute: true })) {
    found.push({ file: path.relative(path.join(root, "..", "..", ".."), file), text: await Bun.file(file).text() })
  }
  return found
}

describe("Northstar Console presentation", () => {
  test("exports canonical display names", () => {
    expect({ BRAND_NAME, CONSOLE_NAME, CLI_NAME, ACCOUNT_NAME, GATEWAY_NAME }).toEqual({
      BRAND_NAME: "Northstar",
      CONSOLE_NAME: "Northstar Console",
      CLI_NAME: "Northstar CLI",
      ACCOUNT_NAME: "Northstar Account",
      GATEWAY_NAME: "Northstar Gateway",
    })
  })

  test("shipped source has no old product copy or executable examples", async () => {
    expect(scanVisibleBrand(await sources())).toEqual([])
  })
})
