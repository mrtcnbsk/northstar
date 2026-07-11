import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { xdgConfig, xdgData } from "xdg-basedir" // kilocode_change
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "kilo")) // kilocode_change
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})

// kilocode_change start - config dir decouple (EPIC 1 Task 1.2): the config dir renames to
// "northstar" while data/cache/state/tmp/log/bin/repos stay on the "kilo" app name, so existing
// users' sqlite DB + sessions are never orphaned by the rebrand.
describe("config dir decouple (northstar)", () => {
  test("config resolves under a northstar-named directory", () => {
    expect(Global.Path.config).toBe(path.join(xdgConfig!.replace(/[\r\n]+/g, ""), "northstar"))
    expect(Global.Path.config.endsWith(path.join("northstar"))).toBe(true)
    expect(Global.make().config).toBe(Global.Path.config)
  })

  test("legacyConfig still resolves under the old kilo-named directory", () => {
    expect(Global.Path.legacyConfig).toBe(path.join(xdgConfig!.replace(/[\r\n]+/g, ""), "kilo"))
  })

  test("config and legacyConfig are different directories", () => {
    expect(Global.Path.config).not.toBe(Global.Path.legacyConfig)
  })

  test("data/cache/state path is unchanged — still under the kilo app name (DB/sessions not orphaned)", () => {
    expect(Global.Path.data).toBe(path.join(xdgData!.replace(/[\r\n]+/g, ""), "kilo"))
    expect(Global.Path.data.endsWith(path.join("kilo"))).toBe(true)
    expect(Global.Path.data.endsWith("northstar")).toBe(false)
  })
})
// kilocode_change end
