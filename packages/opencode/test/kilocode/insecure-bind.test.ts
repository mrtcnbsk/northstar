// kilocode_change - new file: the server must fail closed when exposed beyond loopback without auth.
import { describe, expect, test } from "bun:test"
import { InsecureBind } from "../../src/kilocode/server/insecure-bind"

describe("InsecureBind", () => {
  test("loopback hostnames are never exposed", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1", "", "LOCALHOST"]) {
      expect(InsecureBind.isExposed(h)).toBe(false)
    }
  })

  test("non-loopback hostnames are exposed", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "myhost.local"]) {
      expect(InsecureBind.isExposed(h)).toBe(true)
    }
  })

  test("refuses an exposed bind with no password and no override", () => {
    const r = InsecureBind.check({ hostname: "0.0.0.0", hasPassword: false, allowUnauthenticated: false })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.message).toContain("Refusing to start")
    expect(r.message).toContain("KILO_SERVER_PASSWORD")
  })

  test("allows an exposed bind when a password is set", () => {
    expect(InsecureBind.check({ hostname: "0.0.0.0", hasPassword: true, allowUnauthenticated: false })).toEqual({
      ok: true,
    })
  })

  test("allows an exposed bind when explicitly overridden", () => {
    expect(InsecureBind.check({ hostname: "0.0.0.0", hasPassword: false, allowUnauthenticated: true })).toEqual({
      ok: true,
    })
  })

  test("a loopback bind is always allowed regardless of auth", () => {
    expect(InsecureBind.check({ hostname: "127.0.0.1", hasPassword: false, allowUnauthenticated: false })).toEqual({
      ok: true,
    })
  })

  test("allowUnauthenticatedEnv reads the opt-in env var", () => {
    expect(InsecureBind.allowUnauthenticatedEnv({ KILO_ALLOW_UNAUTHENTICATED: "1" } as NodeJS.ProcessEnv)).toBe(true)
    expect(InsecureBind.allowUnauthenticatedEnv({ KILO_ALLOW_UNAUTHENTICATED: "true" } as NodeJS.ProcessEnv)).toBe(true)
    expect(InsecureBind.allowUnauthenticatedEnv({} as NodeJS.ProcessEnv)).toBe(false)
    expect(InsecureBind.allowUnauthenticatedEnv({ KILO_ALLOW_UNAUTHENTICATED: "0" } as NodeJS.ProcessEnv)).toBe(false)
  })
})
