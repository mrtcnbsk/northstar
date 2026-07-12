// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { scanVisibleBrand } from "../../../../script/user-visible-brand"

describe("user-visible Northstar brand boundary", () => {
  test("rejects old product copy and executable examples", () => {
    expect(
      scanVisibleBrand([
        { file: "packages/opencode/src/visible.ts", text: 'const a = "Ask Kilo"\nconst b = "kilo run"' },
      ]).map((hit) => hit.pattern),
    ).toEqual(["Kilo", "kilo run"])
  })

  test("keeps compatibility identifiers and backend URLs", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/opencode/src/internal.ts",
          text: 'const id = "kilo"\nconst dir = ".kilo"\nconst url = "https://app.kilo.ai"\nimport x from "@kilocode/sdk"',
        },
      ]),
    ).toEqual([])
  })

  test("keeps source comments and stable action IDs", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/kilo-jetbrains/frontend/src/main/example.kt",
          text: '// Kilo compatibility\nconst val ID = "Kilo.NewSession"',
        },
      ]),
    ).toEqual([])
  })

  test("ignores test and spec source files", () => {
    expect(
      scanVisibleBrand([
        { file: "packages/kilo-console/src/brand.test.ts", text: 'expect(copy).toBe("Kilo")' },
        { file: "packages/kilo-vscode/src/brand.spec.ts", text: 'assert.equal(copy, "Kilo Code")' },
      ]),
    ).toEqual([])
  })

  test("reports line numbers", () => {
    expect(scanVisibleBrand([{ file: "x.ts", text: 'ok\nconst title = "Kilo CLI"' }])[0]).toMatchObject({
      file: "x.ts",
      line: 2,
      pattern: "Kilo CLI",
    })
  })
})
