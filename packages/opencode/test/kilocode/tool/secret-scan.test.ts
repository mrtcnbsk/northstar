// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { SecretScanTool, scanText, MAX_BYTES } from "../../../src/kilocode/tool/secret-scan"
import { testEffect } from "../../lib/effect"

const FIXTURES = path.join(__dirname, "fixtures", "secret-scan")

describe("scanText", () => {
  test("no secrets -> empty findings", () => {
    const findings = scanText('let displayName = "World"\nlet timeout = 30\n', "Clean.swift")
    expect(findings).toEqual([])
  })

  test("real assigned secret literal is flagged with redacted snippet", () => {
    const findings = scanText('let apiKey = "sk-live-abcdef123456"\n', "Config.swift")
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe("assigned_secret")
    expect(findings[0].line).toBe(1)
    expect(findings[0].file).toBe("Config.swift")
    // Redacted: shows key name + first/last 2 chars of the value, never the full secret.
    expect(findings[0].snippet).toContain("apiKey")
    expect(findings[0].snippet).not.toContain("sk-live-abcdef123456")
    expect(findings[0].snippet).toContain("sk")
    expect(findings[0].snippet).toContain("56")
  })

  test("AWS access key id is flagged", () => {
    const findings = scanText('let awsKey = "AKIAABCDEFGHIJKLMNOP"\n', "Config.swift")
    expect(findings.some((f) => f.kind === "aws_access_key_id")).toBe(true)
  })

  test("private key header is flagged", () => {
    const findings = scanText("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----\n", "id_rsa")
    expect(findings.some((f) => f.kind === "private_key")).toBe(true)
  })

  test("RSA/EC/OPENSSH/DSA private key variants are all flagged", () => {
    for (const variant of ["RSA ", "EC ", "OPENSSH ", "DSA ", ""]) {
      const findings = scanText(`-----BEGIN ${variant}PRIVATE KEY-----\n`, "key.pem")
      expect(findings.some((f) => f.kind === "private_key")).toBe(true)
    }
  })

  // ---- False-positive guard: placeholder values must NOT be flagged. This is the load-bearing
  // assertion for the scoping decision documented in secret-scan.txt / secret-scan.ts. ----

  test("YOUR_TOKEN_HERE style placeholder is NOT flagged", () => {
    const findings = scanText('let token = "YOUR_TOKEN_HERE"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("YOUR_API_KEY placeholder is NOT flagged", () => {
    const findings = scanText('let apiKey = "YOUR_API_KEY"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("Swift string interpolation is NOT flagged (computed, not a literal secret)", () => {
    const findings = scanText('let token = "\\(computed)"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("shell/JS ${...} interpolation is NOT flagged", () => {
    const findings = scanText('const apiKey = "${process.env.API_KEY}"\n', "config.js")
    expect(findings).toEqual([])
  })

  test("empty string value is NOT flagged", () => {
    const findings = scanText('let secret = ""\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("xxx filler value is NOT flagged", () => {
    const findings = scanText('let password = "xxxxxxxxxxxx"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("angle-bracket placeholder is NOT flagged", () => {
    const findings = scanText('let clientSecret = "<YOUR_CLIENT_SECRET>"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("changeme placeholder is NOT flagged", () => {
    const findings = scanText('let password = "changeme"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("todo placeholder is NOT flagged", () => {
    const findings = scanText('let secretToken = "TODO"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("example placeholder is NOT flagged", () => {
    const findings = scanText('let apiKey = "example"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("value shorter than 8 chars is NOT flagged", () => {
    const findings = scanText('let apiKey = "abc123"\n', "Config.swift")
    expect(findings).toEqual([])
  })

  test("generic high-entropy string with no key-name context is NOT flagged (scoping decision)", () => {
    // A bare UUID/hash-looking literal with no api-key/secret/token/password-style key name
    // must not be flagged — this tool intentionally does not do entropy scanning.
    const findings = scanText('let id = "3f9a1c2b8e7d4f6a9b0c1d2e3f4a5b6c"\n', "Model.swift")
    expect(findings).toEqual([])
  })

  test("multiple secrets on different lines report correct line numbers", () => {
    const text = ['let a = 1', 'let apiKey = "sk-live-abcdef123456"', 'let b = 2', 'let token = "AKIAABCDEFGHIJKLMNOP"'].join(
      "\n",
    )
    const findings = scanText(text, "Multi.swift")
    expect(findings.map((f) => f.line).sort()).toEqual([2, 4])
  })

  // ---- Fix #2: unquoted values in config files (.env/.xcconfig/shell) — the #1 committed-secret
  // vector. Scoped to config-file extensions so code like `apiKey = computeKey()` in a .swift file
  // is NOT flagged (that would be a false positive). ----

  test("unquoted .env assignment (API_KEY=sk-live-...) is flagged and redacted", () => {
    const findings = scanText("API_KEY=sk-live-abcdef123456\n", ".env")
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe("assigned_secret")
    expect(findings[0].snippet).not.toContain("sk-live-abcdef123456")
    expect(findings[0].snippet).toContain("API_KEY")
  })

  test("unquoted .env assignment inside a .env.local dotfile is flagged", () => {
    const findings = scanText("ACCESS_TOKEN=ghp_abcdef1234567890\n", ".env.local")
    expect(findings.some((f) => f.kind === "assigned_secret")).toBe(true)
  })

  test("unquoted .xcconfig assignment is flagged", () => {
    const findings = scanText("API_KEY = sk-live-abcdef123456\n", "Secrets.xcconfig")
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe("assigned_secret")
  })

  test("unquoted assignment in a .swift file is NOT flagged (config-scoped, still code)", () => {
    // The false-positive guard for the scoping decision: `computeKey()` is a function call in code,
    // not a committed literal, and .swift is not a config extension, so the unquoted pattern must
    // not apply here.
    const findings = scanText("let apiKey = computeKey()\n", "Service.swift")
    expect(findings).toEqual([])
  })

  test("unquoted .env placeholder (API_KEY=YOUR_KEY_HERE) is NOT flagged (placeholder guard)", () => {
    const findings = scanText("API_KEY=YOUR_KEY_HERE\n", ".env")
    expect(findings).toEqual([])
  })

  test("unquoted .env value that is a bare function-call is NOT flagged (no parens in value charset)", () => {
    const findings = scanText("API_KEY=compute()\n", "config.env")
    expect(findings).toEqual([])
  })

  // ---- Fix #3: quoted-key formats — JSON `"api_key": "..."` and plist `<key>..</key><string>..`. ----

  test('JSON quoted-key ("api_key": "sk_live_...") is flagged and redacted', () => {
    const findings = scanText('{"api_key": "sk_live_51H8xQ2eZvKYbadf00d"}\n', "config.json")
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe("assigned_secret")
    expect(findings[0].snippet).not.toContain("sk_live_51H8xQ2eZvKYbadf00d")
    expect(findings[0].snippet).toContain("api_key")
  })

  test("JSON quoted-key placeholder is NOT flagged", () => {
    const findings = scanText('{"api_key": "YOUR_KEY"}\n', "config.json")
    expect(findings).toEqual([])
  })

  test("plist <key>api_key</key><string>...</string> on one line is flagged, redacted", () => {
    const findings = scanText("<key>api_key</key><string>sk-live-abc12345</string>\n", "Secrets.plist")
    expect(findings.some((f) => f.kind === "assigned_secret")).toBe(true)
    expect(findings.every((f) => !f.snippet.includes("sk-live-abc12345"))).toBe(true)
  })

  test("plist <key>/<string> across separate lines is flagged (real plist shape)", () => {
    const xml = ["<dict>", "  <key>api_key</key>", "  <string>sk-live-abc12345</string>", "</dict>"].join("\n")
    const findings = scanText(xml, "Secrets.plist")
    expect(findings.some((f) => f.kind === "assigned_secret")).toBe(true)
  })

  test("plist <key>/<string> placeholder value is NOT flagged", () => {
    const findings = scanText("<key>api_key</key><string>YOUR_KEY_HERE</string>\n", "Secrets.plist")
    expect(findings).toEqual([])
  })

  test("plist non-secret key is NOT flagged (CFBundleName)", () => {
    const findings = scanText("<key>CFBundleName</key><string>MyApplication</string>\n", "Info.plist")
    expect(findings).toEqual([])
  })
})

// ---- Effect-harness tests for the execute path (fixture-based) ----

const harness = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Truncate.defaultLayer, Config.defaultLayer, Agent.defaultLayer),
)

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "code",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const runExecute = (params: { paths: string[] }) =>
  Effect.gen(function* () {
    const info = yield* SecretScanTool
    const tool = yield* info.init()
    return yield* tool.execute(params, baseCtx as any)
  })

describe("SecretScanTool execute", () => {
  harness.instance("Clean.swift fixture -> ok:true, no findings", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "Clean.swift")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.findings).toEqual([])
      expect(summary.filesScanned).toBe(1)
      expect(result.metadata.ok).toBe(true)
    }),
  )

  harness.instance("Leaky.swift fixture -> flags real secrets, NOT the placeholder", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "Leaky.swift")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      // Exactly the two real secrets — apiKey and awsAccessKeyId — not the YOUR_TOKEN_HERE placeholder.
      expect(summary.findings).toHaveLength(2)
      const kinds = summary.findings.map((f: any) => f.kind).sort()
      expect(kinds).toEqual(["assigned_secret", "aws_access_key_id"])
      for (const f of summary.findings) {
        expect(f.snippet).not.toContain("YOUR_TOKEN_HERE")
      }
      expect(summary.findings.some((f: any) => f.snippet.includes("token"))).toBe(false)
    }),
  )

  harness.instance("private-key.pem fixture -> private_key finding", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "private-key.pem")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.findings.some((f: any) => f.kind === "private_key")).toBe(true)
    }),
  )

  harness.instance("directory scan recurses and skips nested node_modules", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "nested")] })
      const summary = JSON.parse(result.output)
      // nested/src/Helper.swift is clean (interpolation only); nested/node_modules/somepkg/index.js
      // contains a fake secret but must never be scanned.
      expect(summary.ok).toBe(true)
      expect(summary.findings).toEqual([])
      const scannedNodeModules = summary.filesScanned > 0 && summary.bytesScanned > 0
      expect(scannedNodeModules).toBe(true)
    }),
  )

  harness.instance("binary file is skipped gracefully (never scanned, never throws)", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "binary-asset.png")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.filesScanned).toBe(0)
    }),
  )

  harness.instance("oversized file trips the 2MB cap -> truncated:true, no crash", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({
        paths: [path.join(FIXTURES, "oversized", "Big.swift"), path.join(FIXTURES, "Leaky.swift")],
      })
      const summary = JSON.parse(result.output)
      expect(summary.truncated).toBe(true)
      expect(summary.bytesScanned).toBeLessThanOrEqual(MAX_BYTES)
    }),
  )

  harness.instance("nonexistent path is skipped with a note, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "does-not-exist.swift")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.filesScanned).toBe(0)
    }),
  )

  harness.instance(".env fixture with an unquoted secret -> flagged (dotenv is the #1 leak vector)", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "dotenv-secret.env")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.findings.some((f: any) => f.kind === "assigned_secret")).toBe(true)
    }),
  )

  harness.instance("config.json fixture with a quoted-key secret -> flagged, value never exposed", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "config-secret.json")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.findings.some((f: any) => f.kind === "assigned_secret")).toBe(true)
      for (const f of summary.findings) expect(f.snippet).not.toContain("sk_live_51H8xQ2eZvKYbadf00d")
    }),
  )

  harness.instance("plist fixture with a <key>/<string> secret -> flagged; non-secret keys ignored", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ paths: [path.join(FIXTURES, "Secrets.plist")] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.findings.some((f: any) => f.kind === "assigned_secret")).toBe(true)
      // Only the api_key entry — CFBundleName is not secret-ish.
      expect(summary.findings).toHaveLength(1)
    }),
  )
})
