// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { rewriteVisibleBrand, scanVisibleBrand } from "../../../../script/user-visible-brand"

describe("user-visible Northstar brand boundary", () => {
  test("rejects old product copy and executable examples", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/opencode/src/visible.ts",
          text: 'const a = "Ask Kilo"\nconst b = "kilo run"\nconst c = "kilo --continue"',
        },
      ]).map((hit) => hit.pattern),
    ).toEqual(["Kilo", "kilo run", "kilo --continue"])
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

  test("keeps source comments, protocol metadata, and stable action IDs", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/kilo-jetbrains/frontend/src/main/example.kt",
          text: [
            '// Kilo compatibility',
            'const val ID = "Kilo.NewSession" // Kilo compatibility action',
            'const headers = { "X-Title": "Kilo Code", "User-Agent": "Kilo-Code/1.0" }',
            'const integration = { "X-Cerebras-3rd-Party-Integration": "Kilo Code" }',
            'uses: Kilo-Org/kilocode/github@latest',
          ].join("\n"),
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

  test("rewrites only classified display copy, even beside a stable action ID", () => {
    expect(
      rewriteVisibleBrand({
        file: "visible.ts",
        text: 'const id = "Kilo.NewSession"; const title = "Kilo CLI"; const command = "kilo run"',
      }),
    ).toBe('const id = "Kilo.NewSession"; const title = "Northstar"; const command = "northstar run"')
  })
})
