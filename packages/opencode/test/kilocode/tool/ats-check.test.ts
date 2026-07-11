// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { AtsCheckTool, checkAts } from "../../../src/kilocode/tool/ats-check"
import { testEffect } from "../../lib/effect"

const FIXTURES = path.join(__dirname, "fixtures")

describe("checkAts", () => {
  test("no NSAppTransportSecurity key -> ok:true (default-secure)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.ilura.keel</string>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  test("NSAllowsArbitraryLoads=true -> violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.key === "NSAllowsArbitraryLoads")).toBe(true)
  })

  test("NSAllowsArbitraryLoadsInWebContent=true -> violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoadsInWebContent</key>
		<true/>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.key === "NSAllowsArbitraryLoadsInWebContent")).toBe(true)
  })

  test("NSAllowsArbitraryLoadsForMedia=true -> violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoadsForMedia</key>
		<true/>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.key === "NSAllowsArbitraryLoadsForMedia")).toBe(true)
  })

  test("NSExceptionDomains entry with insecure HTTP loads -> violation with domain", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSExceptionDomains</key>
		<dict>
			<key>legacy.example.com</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<true/>
			</dict>
		</dict>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.key === "NSExceptionAllowsInsecureHTTPLoads")
    expect(violation).toBeDefined()
    expect(violation!.domain).toBe("legacy.example.com")
  })

  test("strict ATS config (all false / TLS pinned) -> ok:true", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<false/>
		<key>NSExceptionDomains</key>
		<dict>
			<key>api.ilura.co</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<false/>
				<key>NSExceptionMinimumTLSVersion</key>
				<string>TLSv1.2</string>
			</dict>
		</dict>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  test("multiple exception domains, only one insecure -> only that domain flagged", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSExceptionDomains</key>
		<dict>
			<key>secure.example.com</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<false/>
			</dict>
			<key>insecure.example.com</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key>
				<true/>
			</dict>
		</dict>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].domain).toBe("insecure.example.com")
  })

  // ---- Fix #1: XML comments must be stripped BEFORE the well-formedness/tag-balance check, and a
  // genuinely malformed plist must FAIL CLOSED (ok:false) instead of reporting secure. ----

  test("comment with a stray <key> no longer trips balance; the insecure setting IS caught (fail-open bug closed)", () => {
    // Without comment-stripping, the `<key>` inside the comment makes the tag-balance heuristic
    // report the plist malformed, and the OLD code silently returned ok:true — shipping an
    // ATS-disabled app as compliant. This is the exact adversarial-review input.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<!-- the <key> below disables ATS entirely -->
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.key === "NSAllowsArbitraryLoads")).toBe(true)
  })

  test("genuinely malformed/truncated plist -> ok:false with a file violation (fail closed, never silently secure)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>` // truncated: missing closing dicts + </plist>
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.key === "file")).toBe(true)
  })

  test("valid plist with a benign comment still parses; clean config -> ok:true (no false-malformed)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<!-- App Transport Security: all secure, comment intentionally left in -->
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<false/>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  // ---- Fix #5: the third-party insecure-HTTP exception key. ----

  test("NSThirdPartyExceptionAllowsInsecureHTTPLoads=true -> violation with domain", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSExceptionDomains</key>
		<dict>
			<key>ads.thirdparty.com</key>
			<dict>
				<key>NSThirdPartyExceptionAllowsInsecureHTTPLoads</key>
				<true/>
			</dict>
		</dict>
	</dict>
</dict>
</plist>`
    const result = checkAts(xml)
    expect(result.ok).toBe(false)
    const violation = result.violations.find((v) => v.key === "NSThirdPartyExceptionAllowsInsecureHTTPLoads")
    expect(violation).toBeDefined()
    expect(violation!.domain).toBe("ads.thirdparty.com")
  })
})

// ---- Effect-harness tests for the execute path ----

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

const runExecute = (params: { plistPath: string }) =>
  Effect.gen(function* () {
    const info = yield* AtsCheckTool
    const tool = yield* info.init()
    return yield* tool.execute(params, baseCtx as any)
  })

describe("AtsCheckTool execute", () => {
  harness.instance("plist with no ATS key -> ok:true", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "Info-no-ats.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.violations).toEqual([])
      expect(result.metadata.ok).toBe(true)
    }),
  )

  harness.instance("NSAllowsArbitraryLoads=true fixture -> ok:false, violation", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "Info-arbitrary-loads.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.key === "NSAllowsArbitraryLoads")).toBe(true)
    }),
  )

  harness.instance("exception domain with insecure loads fixture -> violation with domain", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "Info-exception-domain-insecure.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations[0].domain).toBe("legacy.example.com")
    }),
  )

  harness.instance("strict ATS fixture -> ok:true", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "Info-strict-ats.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.violations).toEqual([])
    }),
  )

  harness.instance("missing file -> ok:false, file violation, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "does-not-exist.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.key === "file")).toBe(true)
    }),
  )

  harness.instance("plist with a comment hiding a stray <key> -> insecure setting still caught", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "Info-comment-arbitrary-loads.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.key === "NSAllowsArbitraryLoads")).toBe(true)
    }),
  )

  harness.instance("malformed plist fixture -> ok:false, file violation (fail closed, not silently secure)", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ plistPath: path.join(FIXTURES, "Info-malformed.plist") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.key === "file")).toBe(true)
    }),
  )
})
