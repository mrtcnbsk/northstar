// kilocode_change - new file: DNS-rebinding Host-header guard must block only the rebinding vector.
import { describe, expect, test } from "bun:test"
import { HostGuard } from "../../src/kilocode/server/host-guard"

describe("HostGuard.isRebinding", () => {
  test("legitimate local Host headers are never flagged (fail open)", () => {
    for (const h of [
      undefined,
      "",
      "localhost",
      "localhost:4096",
      "127.0.0.1",
      "127.0.0.1:8080",
      "0.0.0.0:3000",
      "192.168.1.10:5000",
      "10.0.0.5",
      "::1",
      "[::1]:4096",
      "myhost", // single-label hostname
      "kilo.local", // mDNS
      "kilo.local:1234",
      "printer.localhost",
    ]) {
      expect(HostGuard.isRebinding(h)).toBe(false)
    }
  })

  test("public multi-label domains are flagged as rebinding", () => {
    for (const h of ["attacker.com", "attacker.com:4096", "evil.example.org", "a.b.co.uk:80", "sub.malicious.io"]) {
      expect(HostGuard.isRebinding(h)).toBe(true)
    }
  })

  test("case and surrounding whitespace do not evade the check", () => {
    expect(HostGuard.isRebinding("  ATTACKER.COM:4096 ")).toBe(true)
    expect(HostGuard.isRebinding("LOCALHOST:4096")).toBe(false)
  })
})
