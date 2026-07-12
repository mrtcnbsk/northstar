// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { rewriteVisibleBrand, scanVisibleBrand } from "../../../../script/user-visible-brand"

describe("user-visible Northstar brand boundary", () => {
  test("rejects old product copy and executable examples", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/opencode/src/visible.ts",
          text: [
            'const a = "Ask Kilo"',
            'const b = "kilo run"',
            'const c = "kilo --continue"',
            'const d = "https://github.com/Kilo-Org/kilocode"; const e = "Kilo"',
          ].join("\n"),
        },
      ]).map((hit) => hit.pattern),
    ).toEqual(["Kilo", "kilo run", "kilo --continue", "Kilo"])
  })

  test("keeps compatibility identifiers and backend URLs", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/opencode/src/internal.ts",
          text: [
            'const id = "kilo"',
            'const dir = ".kilo"',
            'const url = "https://app.kilo.ai"',
            'const repo = "https://github.com/Kilo-Org/kilocode"',
            'const slug = "Kilo-Org/kilocode"',
            'import x from "@kilocode/sdk"',
          ].join("\n"),
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

  test("keeps stable JetBrains extension IDs", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/kilo-jetbrains/frontend/src/main/resources/kilo.jetbrains.frontend.xml",
          text: '<toolWindow id="Kilo Code"/>\n<notificationGroup id="Kilo Code"/>',
        },
        {
          file: "packages/kilo-jetbrains/frontend/src/main/kotlin/example.kt",
          text: [
            'const val GROUP_ID = "Kilo Code"',
            'manager.getToolWindow("Kilo Code")',
            'manager.getNotificationGroup("Kilo Code")',
            'check(note.groupId == "Kilo Code")',
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

  test("keeps frozen legacy migration fixtures", () => {
    expect(
      scanVisibleBrand([
        {
          file: "packages/kilo-vscode/src/legacy-migration/native-mode-defaults.ts",
          text: 'const legacy = "You are Kilo Code, an experienced technical leader"',
        },
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
