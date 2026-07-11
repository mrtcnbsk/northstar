// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import { PrivacyManifestCheckTool, parsePrivacyManifest } from "../../../src/kilocode/tool/privacy-manifest-check"
import { testEffect } from "../../lib/effect"

const FIXTURES = path.join(__dirname, "fixtures")

describe("parsePrivacyManifest", () => {
  test("compliant manifest: declared API with non-empty reasons -> ok:true, no violations", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSPrivacyTracking</key>
	<false/>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>CA92.1</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`
    const result = parsePrivacyManifest(xml)
    expect(result.ok).toBe(true)
    expect(result.status).toBe("ok")
    expect(result.violations).toEqual([])
  })

  test("declared API with EMPTY reasons -> violation even with no requiredReasonAPIs", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array/>
		</dict>
	</array>
</dict>
</plist>`
    const result = parsePrivacyManifest(xml)
    expect(result.ok).toBe(false)
    expect(result.status).toBe("ok") // parsed fine; violations come from content, not parse status
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0].api).toBe("NSPrivacyAccessedAPICategoryUserDefaults")
  })

  test("requiredReasonAPIs entry not declared in manifest -> violation", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>CA92.1</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`
    const result = parsePrivacyManifest(xml, ["NSPrivacyAccessedAPICategoryFileTimestamp"])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.api === "NSPrivacyAccessedAPICategoryFileTimestamp")).toBe(true)
  })

  test("requiredReasonAPIs entry declared with reasons -> no violation for that API", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>CA92.1</string>
			</array>
		</dict>
	</array>
</dict>
</plist>`
    const result = parsePrivacyManifest(xml, ["NSPrivacyAccessedAPICategoryUserDefaults"])
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
  })

  test("malformed XML -> status invalid, ok:false", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>` // truncated, unclosed tags
    const result = parsePrivacyManifest(xml)
    expect(result.ok).toBe(false)
    expect(result.status).toBe("invalid")
    expect(result.violations.length).toBeGreaterThan(0)
  })

  test("empty string input -> status invalid", () => {
    const result = parsePrivacyManifest("")
    expect(result.ok).toBe(false)
    expect(result.status).toBe("invalid")
  })

  test("multiple declared APIs, only one with empty reasons -> only that one flagged", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>NSPrivacyAccessedAPITypes</key>
	<array>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryUserDefaults</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array>
				<string>CA92.1</string>
			</array>
		</dict>
		<dict>
			<key>NSPrivacyAccessedAPIType</key>
			<string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
			<key>NSPrivacyAccessedAPITypeReasons</key>
			<array/>
		</dict>
	</array>
</dict>
</plist>`
    const result = parsePrivacyManifest(xml)
    expect(result.ok).toBe(false)
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0].api).toBe("NSPrivacyAccessedAPICategoryFileTimestamp")
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

const runExecute = (params: { manifestPath: string; requiredReasonAPIs?: string[] }) =>
  Effect.gen(function* () {
    const info = yield* PrivacyManifestCheckTool
    const tool = yield* info.init()
    return yield* tool.execute(params, baseCtx as any)
  })

describe("PrivacyManifestCheckTool execute", () => {
  harness.instance("compliant fixture -> ok:true, status ok, no violations", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ manifestPath: path.join(FIXTURES, "PrivacyInfo-compliant.xcprivacy") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.status).toBe("ok")
      expect(summary.violations).toEqual([])
      expect(result.metadata.ok).toBe(true)
    }),
  )

  harness.instance("empty-reasons fixture -> ok:false, violation present", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ manifestPath: path.join(FIXTURES, "PrivacyInfo-empty-reasons.xcprivacy") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.length).toBeGreaterThan(0)
    }),
  )

  harness.instance("missing file -> status missing_manifest, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ manifestPath: path.join(FIXTURES, "does-not-exist.xcprivacy") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("missing_manifest")
      expect(summary.violations.length).toBeGreaterThan(0)
    }),
  )

  harness.instance("requiredReasonAPIs not declared -> violation surfaces through execute", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({
        manifestPath: path.join(FIXTURES, "PrivacyInfo-compliant.xcprivacy"),
        requiredReasonAPIs: ["NSPrivacyAccessedAPICategoryFileTimestamp"],
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.api === "NSPrivacyAccessedAPICategoryFileTimestamp")).toBe(true)
    }),
  )

  harness.instance("malformed fixture -> status invalid, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ manifestPath: path.join(FIXTURES, "PrivacyInfo-malformed.xcprivacy") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.status).toBe("invalid")
    }),
  )
})
