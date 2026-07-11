// kilocode_change - new file
import { describe, expect, test, afterEach } from "bun:test"
import { resolveEnv, Flag } from "@opencode-ai/core/flag/flag"

const KEYS = ["NORTHSTAR_TEST_FLAG", "KILO_TEST_FLAG"]

function reset() {
  for (const key of KEYS) delete process.env[key]
}

afterEach(reset)

describe("resolveEnv (NORTHSTAR_* primary, KILO_* fallback)", () => {
  test("returns undefined when neither var is set", () => {
    reset()
    expect(resolveEnv("NORTHSTAR_TEST_FLAG", "KILO_TEST_FLAG")).toBeUndefined()
  })

  test("falls back to the old KILO_* var when the new NORTHSTAR_* var is unset", () => {
    reset()
    process.env.KILO_TEST_FLAG = "legacy-value"
    expect(resolveEnv("NORTHSTAR_TEST_FLAG", "KILO_TEST_FLAG")).toBe("legacy-value")
  })

  test("prefers the new NORTHSTAR_* var when only it is set", () => {
    reset()
    process.env.NORTHSTAR_TEST_FLAG = "new-value"
    expect(resolveEnv("NORTHSTAR_TEST_FLAG", "KILO_TEST_FLAG")).toBe("new-value")
  })

  test("prefers the new NORTHSTAR_* var over the old KILO_* var when both are set", () => {
    reset()
    process.env.NORTHSTAR_TEST_FLAG = "new-value"
    process.env.KILO_TEST_FLAG = "legacy-value"
    expect(resolveEnv("NORTHSTAR_TEST_FLAG", "KILO_TEST_FLAG")).toBe("new-value")
  })

  test("with no oldKey, behaves like a plain env lookup", () => {
    reset()
    process.env.NORTHSTAR_TEST_FLAG = "solo-value"
    expect(resolveEnv("NORTHSTAR_TEST_FLAG")).toBe("solo-value")
  })
})

describe("Flag config-critical dual-read (NORTHSTAR_* primary, KILO_* fallback)", () => {
  const original = {
    KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
    NORTHSTAR_CONFIG_DIR: process.env.NORTHSTAR_CONFIG_DIR,
    KILO_TUI_CONFIG: process.env.KILO_TUI_CONFIG,
    NORTHSTAR_TUI_CONFIG: process.env.NORTHSTAR_TUI_CONFIG,
    KILO_DISABLE_PROJECT_CONFIG: process.env.KILO_DISABLE_PROJECT_CONFIG,
    NORTHSTAR_DISABLE_PROJECT_CONFIG: process.env.NORTHSTAR_DISABLE_PROJECT_CONFIG,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test("KILO_CONFIG_DIR (getter) still honored when NORTHSTAR_CONFIG_DIR is unset", () => {
    delete process.env.NORTHSTAR_CONFIG_DIR
    process.env.KILO_CONFIG_DIR = "/tmp/legacy-config-dir"
    expect(Flag.KILO_CONFIG_DIR).toBe("/tmp/legacy-config-dir")
  })

  test("NORTHSTAR_CONFIG_DIR (getter) takes precedence over KILO_CONFIG_DIR", () => {
    process.env.NORTHSTAR_CONFIG_DIR = "/tmp/new-config-dir"
    process.env.KILO_CONFIG_DIR = "/tmp/legacy-config-dir"
    expect(Flag.KILO_CONFIG_DIR).toBe("/tmp/new-config-dir")
  })

  test("KILO_TUI_CONFIG (getter) dual-reads NORTHSTAR_TUI_CONFIG first", () => {
    delete process.env.NORTHSTAR_TUI_CONFIG
    process.env.KILO_TUI_CONFIG = "/tmp/legacy-tui.jsonc"
    expect(Flag.KILO_TUI_CONFIG).toBe("/tmp/legacy-tui.jsonc")

    process.env.NORTHSTAR_TUI_CONFIG = "/tmp/new-tui.jsonc"
    expect(Flag.KILO_TUI_CONFIG).toBe("/tmp/new-tui.jsonc")
  })

  test("KILO_DISABLE_PROJECT_CONFIG (getter) dual-reads NORTHSTAR_DISABLE_PROJECT_CONFIG first", () => {
    delete process.env.NORTHSTAR_DISABLE_PROJECT_CONFIG
    process.env.KILO_DISABLE_PROJECT_CONFIG = "true"
    expect(Flag.KILO_DISABLE_PROJECT_CONFIG).toBe(true)

    delete process.env.KILO_DISABLE_PROJECT_CONFIG
    process.env.NORTHSTAR_DISABLE_PROJECT_CONFIG = "true"
    expect(Flag.KILO_DISABLE_PROJECT_CONFIG).toBe(true)
  })
})
