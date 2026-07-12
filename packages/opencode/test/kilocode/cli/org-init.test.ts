// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import * as ConfigAgent from "../../../src/config/agent"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgTemplates, handleInit } from "../../../src/kilocode/cli/cmd/org"
import { tmpdir } from "../../fixture/fixture"

const TEMPLATES_DIR = path.resolve(import.meta.dir, "../../../../..", "templates")

function harness() {
  const logs: string[] = []
  const errors: string[] = []
  const codes: number[] = []
  return {
    logs,
    errors,
    codes,
    log: (msg: string) => logs.push(msg),
    error: (msg: string) => errors.push(msg),
    exit: (code: number) => codes.push(code),
  }
}

describe("org init", () => {
  test("scaffolds .kilo/ from the ios-app-factory template and validates it (11 stages / 63 agents)", async () => {
    await using tmp = await tmpdir()
    const h = harness()

    await handleInit({
      template: "ios-app-factory",
      force: false,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: h.log,
      error: h.error,
      exit: h.exit,
    })

    expect(h.errors).toEqual([])
    expect(h.codes).toEqual([])

    expect(existsSync(path.join(tmp.path, ".kilo", "organization.jsonc"))).toBe(true)
    expect(existsSync(path.join(tmp.path, ".kilo", "agents"))).toBe(true)

    const org = await OrgSchema.loadOrganization(tmp.path)
    expect(org.pipeline.length).toBe(11)

    const agents = await ConfigAgent.load(path.join(tmp.path, ".kilo"))
    expect(Object.keys(agents).length).toBe(63)

    const summary = h.logs.join("\n")
    expect(summary).toContain("ios-app-factory")
    expect(summary).toContain("11")
    expect(summary).toContain("63")
  })

  test("errors on an unknown template name and lists available templates", async () => {
    await using tmp = await tmpdir()
    const h = harness()

    await handleInit({
      template: "does-not-exist",
      force: false,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: h.log,
      error: h.error,
      exit: h.exit,
    })

    expect(h.codes).toEqual([1])
    expect(h.errors.length).toBe(1)
    expect(h.errors[0]).toContain("does-not-exist")
    expect(h.errors[0]).toContain("ios-app-factory")
    expect(existsSync(path.join(tmp.path, ".kilo"))).toBe(false)
  })

  test("refuses to clobber an existing .kilo/organization.jsonc without --force", async () => {
    await using tmp = await tmpdir()
    const first = harness()
    await handleInit({
      template: "ios-app-factory",
      force: false,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: first.log,
      error: first.error,
      exit: first.exit,
    })
    expect(first.errors).toEqual([])

    const orgFile = path.join(tmp.path, ".kilo", "organization.jsonc")
    const marker = "// marker - must survive a non-force re-init\n"
    const original = await fs.readFile(orgFile, "utf8")
    await fs.writeFile(orgFile, marker + original)

    const second = harness()
    await handleInit({
      template: "ios-app-factory",
      force: false,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: second.log,
      error: second.error,
      exit: second.exit,
    })

    expect(second.codes).toEqual([1])
    expect(second.errors.length).toBe(1)
    expect(second.errors[0]).toContain("--force")

    const after = await fs.readFile(orgFile, "utf8")
    expect(after.startsWith(marker)).toBe(true)
  })

  test("--force overwrites an existing .kilo/", async () => {
    await using tmp = await tmpdir()
    const first = harness()
    await handleInit({
      template: "ios-app-factory",
      force: false,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: first.log,
      error: first.error,
      exit: first.exit,
    })
    expect(first.errors).toEqual([])

    const orgFile = path.join(tmp.path, ".kilo", "organization.jsonc")
    const marker = "// marker - must be overwritten by --force\n"
    const original = await fs.readFile(orgFile, "utf8")
    await fs.writeFile(orgFile, marker + original)

    const second = harness()
    await handleInit({
      template: "ios-app-factory",
      force: true,
      cwd: tmp.path,
      templatesDir: TEMPLATES_DIR,
      log: second.log,
      error: second.error,
      exit: second.exit,
    })

    expect(second.errors).toEqual([])
    expect(second.codes).toEqual([])

    const after = await fs.readFile(orgFile, "utf8")
    expect(after.startsWith(marker)).toBe(false)

    const org = await OrgSchema.loadOrganization(tmp.path)
    expect(org.pipeline.length).toBe(11)
  })
})

describe("OrgTemplates.dir resolution", () => {
  const ENV = "KILO_ORG_TEMPLATES_DIR"
  const original = process.env[ENV]

  function restore() {
    if (original === undefined) delete process.env[ENV]
    else process.env[ENV] = original
  }

  test("honors KILO_ORG_TEMPLATES_DIR override when it exists", async () => {
    await using tmp = await tmpdir()
    process.env[ENV] = tmp.path
    try {
      expect(OrgTemplates.dir()).toBe(tmp.path)
    } finally {
      restore()
    }
  })

  test("falls back to the repo-root templates/ dir in dev/source (no override, no installed-binary dir)", () => {
    delete process.env[ENV]
    try {
      expect(OrgTemplates.dir()).toBe(TEMPLATES_DIR)
    } finally {
      restore()
    }
  })
})
