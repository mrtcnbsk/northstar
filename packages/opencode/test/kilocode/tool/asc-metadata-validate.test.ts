// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import {
  AscMetadataValidateTool,
  validateAscMetadata,
  type MetadataEntry,
} from "../../../src/kilocode/tool/asc-metadata-validate"
import { testEffect } from "../../lib/effect"

const FIXTURES = path.join(__dirname, "fixtures")

const baseEntry: MetadataEntry = {
  locale: "en-US",
  name: "Keel",
  subtitle: "Cash flow copilot",
  promotionalText: "See your money, decide fast.",
  keywords: "budget,finance,ledger",
  description: "An on-device cash-flow copilot that never leaves your phone.",
}

describe("validateAscMetadata", () => {
  test("name of 31 code points -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, name: "a".repeat(31) }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "name" && v.locale === "en-US")).toBe(true)
  })

  test("name of exactly 30 code points -> ok", () => {
    const entry: MetadataEntry = { ...baseEntry, name: "a".repeat(30) }
    const result = validateAscMetadata([entry])
    expect(result.violations.some((v) => v.field === "name")).toBe(false)
  })

  test("subtitle over 30 -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, subtitle: "a".repeat(31) }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "subtitle")).toBe(true)
  })

  test("keywords string of 101 characters -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, keywords: "a".repeat(101) }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "keywords")).toBe(true)
  })

  test("keywords string of exactly 100 characters -> ok", () => {
    const entry: MetadataEntry = { ...baseEntry, keywords: "a".repeat(100) }
    const result = validateAscMetadata([entry])
    expect(result.violations.some((v) => v.field === "keywords")).toBe(false)
  })

  test("promotionalText of 171 characters -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, promotionalText: "a".repeat(171) }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "promotionalText")).toBe(true)
  })

  test("description of 4001 characters -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, description: "a".repeat(4001) }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "description")).toBe(true)
  })

  test("description of exactly 4000 characters -> ok", () => {
    const entry: MetadataEntry = { ...baseEntry, description: "a".repeat(4000) }
    const result = validateAscMetadata([entry])
    expect(result.violations.some((v) => v.field === "description")).toBe(false)
  })

  test("missing name on the primary locale -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, name: undefined }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "name" && v.message.includes("required"))).toBe(true)
  })

  test("empty-string name on the primary locale -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, name: "   " }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "name" && v.message.includes("required"))).toBe(true)
  })

  test("missing description on the primary locale -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, description: undefined }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "description" && v.message.includes("required"))).toBe(true)
  })

  test("secondary locale may omit name/description without a required-field violation", () => {
    const secondary: MetadataEntry = { locale: "de-DE", subtitle: "Cashflow-Copilot" }
    const result = validateAscMetadata([baseEntry, secondary])
    expect(result.violations.some((v) => v.locale === "de-DE" && v.message.includes("required"))).toBe(false)
  })

  test("unknown locale code -> violation", () => {
    const entry: MetadataEntry = { ...baseEntry, locale: "xx-YY" }
    const result = validateAscMetadata([entry])
    expect(result.ok).toBe(false)
    expect(result.violations.some((v) => v.field === "locale" && v.locale === "xx-YY")).toBe(true)
  })

  test("recognized non-region locale code (e.g. 'ja') -> ok", () => {
    const entry: MetadataEntry = { ...baseEntry, locale: "ja" }
    const result = validateAscMetadata([entry])
    expect(result.violations.some((v) => v.field === "locale")).toBe(false)
  })

  test("emoji-heavy name at 30 code points but >30 UTF-16 units -> ok (proves code-point counting)", () => {
    // Each of these emoji is an astral-plane character: 1 Unicode code point, 2 UTF-16 units.
    // 30 of them is exactly the 30-code-point limit but 60 UTF-16 units — a naive `.length` check
    // would wrongly flag this as more than double the limit.
    const emojiName = "🚀".repeat(30)
    expect(emojiName.length).toBeGreaterThan(30) // sanity: UTF-16 length is NOT 30
    const entry: MetadataEntry = { ...baseEntry, name: emojiName }
    const result = validateAscMetadata([entry])
    expect(result.violations.some((v) => v.field === "name")).toBe(false)
  })

  test("emoji-heavy name at 31 code points -> violation (still over the code-point limit)", () => {
    const emojiName = "🚀".repeat(31)
    const entry: MetadataEntry = { ...baseEntry, name: emojiName }
    const result = validateAscMetadata([entry])
    expect(result.violations.some((v) => v.field === "name")).toBe(true)
  })

  test("empty entries array -> violation (fails closed, never silently ok)", () => {
    const result = validateAscMetadata([])
    expect(result.ok).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
  })

  test("all fields within limits, known locales, required fields present -> ok:true, []", () => {
    const result = validateAscMetadata([baseEntry, { locale: "de-DE", name: "Keel", description: "Übersetzung." }])
    expect(result).toEqual({ ok: true, violations: [] })
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

const runExecute = (params: { metadataPath?: string; entries?: MetadataEntry[] }) =>
  Effect.gen(function* () {
    const info = yield* AscMetadataValidateTool
    const tool = yield* info.init()
    return yield* tool.execute(params, baseCtx as any)
  })

describe("AscMetadataValidateTool execute", () => {
  harness.instance("inline entries within limits -> ok:true", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ entries: [baseEntry] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.violations).toEqual([])
      expect(result.metadata.ok).toBe(true)
    }),
  )

  harness.instance("inline entries over a limit -> ok:false, violation", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ entries: [{ ...baseEntry, name: "a".repeat(31) }] })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.field === "name")).toBe(true)
    }),
  )

  harness.instance("metadataPath fixture: markdown deliverable with a fenced ```json block -> parsed + validated", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ metadataPath: path.join(FIXTURES, "marketing-listing-valid.md") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.violations).toEqual([])
      expect(summary.rawPath).toBe(path.join(FIXTURES, "marketing-listing-valid.md"))
    }),
  )

  harness.instance("malformed metadataPath fixture -> fail-closed invalid, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ metadataPath: path.join(FIXTURES, "marketing-listing-malformed.md") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.field === "file")).toBe(true)
    }),
  )

  harness.instance("missing file -> ok:false, file violation, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({ metadataPath: path.join(FIXTURES, "does-not-exist.md") })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.field === "file")).toBe(true)
    }),
  )

  harness.instance("neither metadataPath nor entries -> ok:false, params violation, never throws", () =>
    Effect.gen(function* () {
      const result = yield* runExecute({})
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.violations.some((v: any) => v.field === "params")).toBe(true)
    }),
  )
})
