// kilocode_change - new file
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import * as Tool from "@/tool/tool"
import DESCRIPTION from "./asc-metadata-validate.txt"

export const MetadataEntry = Schema.Struct({
  locale: Schema.String.annotate({
    description: "BCP-47 locale code as used by App Store Connect (e.g. en-US, ja, zh-Hans).",
  }),
  name: Schema.optional(Schema.String),
  subtitle: Schema.optional(Schema.String),
  promotionalText: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
})
export type MetadataEntry = Schema.Schema.Type<typeof MetadataEntry>

export const Params = Schema.Struct({
  metadataPath: Schema.optional(Schema.String).annotate({
    description:
      "Filesystem path to a metadata deliverable to validate: either a JSON file containing an array of locale metadata entries, or a markdown deliverable containing a fenced ```json code block with that array. Ignored when `entries` is provided.",
  }),
  entries: Schema.optional(Schema.Array(MetadataEntry)).annotate({
    description: "Inline array of locale metadata entries to validate, instead of reading `metadataPath` from disk.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type AscViolation = {
  locale: string
  field: string
  message: string
}

export type AscMetadataResult = {
  ok: boolean
  violations: AscViolation[]
  rawPath?: string
}

/**
 * Static App Store Connect metadata length limits (code points, not bytes/UTF-16 units — see
 * `codePointLength`). Source: Apple's App Store Connect "App Information" / "Version Information"
 * field limits as documented for app name, subtitle, promotional text, keywords, and description
 * (developer.apple.com/help/app-store-connect/reference/limits — name 30, subtitle 30, promotional
 * text 170, keywords 100, description 4000). `keywords` here is the single comma-joined string ASC
 * stores per locale, so its 100-char limit applies to the joined string as a whole, not per keyword.
 */
const LIMITS = {
  name: 30,
  subtitle: 30,
  promotionalText: 170,
  keywords: 100,
  description: 4000,
} as const

type LimitedField = keyof typeof LIMITS
const LIMITED_FIELDS = Object.keys(LIMITS) as LimitedField[]

/**
 * A reasonable, explicitly-sourced subset of App Store Connect's supported localizations (BCP-47
 * codes). ASC's actual supported-locale list is longer and occasionally changes; this allowlist
 * covers the common ones (source: App Store Connect's "Add Localization" locale picker /
 * developer.apple.com/help/app-store-connect/reference/app-store-localizations). An unrecognized
 * locale is flagged as a violation rather than silently accepted, since a typo'd or unsupported
 * locale code would otherwise fail at submission time inside App Store Connect itself.
 */
const ASC_LOCALE_ALLOWLIST = new Set([
  "en-US",
  "en-GB",
  "en-CA",
  "en-AU",
  "fr-FR",
  "fr-CA",
  "de-DE",
  "es-ES",
  "es-MX",
  "it",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
  "pt-BR",
  "pt-PT",
  "ru",
  "nl-NL",
  "sv",
  "da",
  "fi",
  "no",
  "pl",
  "tr",
  "ar-SA",
  "th",
  "id",
  "vi",
  "ms",
  "hi",
  "cs",
  "sk",
  "hu",
  "el",
  "he",
  "ro",
  "uk",
  "hr",
  "ca",
])

/**
 * Count Unicode CODE POINTS, not UTF-16 code units and not `.length` — a plain `string.length`
 * counts UTF-16 units, so a name built from astral-plane emoji (each 2 UTF-16 units but 1 code
 * point) would be over-counted and wrongly flagged as exceeding a limit it doesn't actually exceed.
 * Spreading the string iterates by code point, which matches how App Store Connect itself counts
 * character limits for non-BMP characters.
 */
function codePointLength(value: string): number {
  return [...value].length
}

/**
 * Pure validator: checks App Store Connect locale metadata entries against Apple's static length
 * limits, a locale allowlist, and required-field presence on the PRIMARY locale. No I/O — safe to
 * unit test with captured fixtures.
 *
 * Primary-locale convention: the FIRST entry in `entries` is treated as the primary locale (the one
 * App Store Connect requires `name`/`description` on before a listing can ship); secondary
 * localizations may omit fields to inherit from the primary. This mirrors how a marketing deliverable
 * naturally orders its locales (primary first, translations after) and avoids requiring an explicit
 * `primary: true` flag the callers producing this data don't otherwise need.
 *
 * Fails CLOSED: an empty `entries` array is itself a violation (nothing to ship), never a silent
 * `ok: true`.
 */
export function validateAscMetadata(entries: readonly MetadataEntry[]): AscMetadataResult {
  const violations: AscViolation[] = []

  if (entries.length === 0) {
    return {
      ok: false,
      violations: [{ locale: "", field: "entries", message: "no locale metadata entries provided" }],
    }
  }

  entries.forEach((entry, index) => {
    const locale = entry.locale

    if (!ASC_LOCALE_ALLOWLIST.has(locale)) {
      violations.push({
        locale,
        field: "locale",
        message: `"${locale}" is not a recognized App Store Connect locale code`,
      })
    }

    for (const field of LIMITED_FIELDS) {
      const value = entry[field]
      if (value === undefined) continue
      const length = codePointLength(value)
      const limit = LIMITS[field]
      if (length > limit) {
        violations.push({
          locale,
          field,
          message: `${field} is ${length} characters, exceeding the App Store Connect limit of ${limit}`,
        })
      }
    }

    // Required fields apply only to the primary locale (the first entry) — see docstring.
    if (index === 0) {
      if (!entry.name || entry.name.trim().length === 0) {
        violations.push({ locale, field: "name", message: "name is required for the primary locale" })
      }
      if (!entry.description || entry.description.trim().length === 0) {
        violations.push({ locale, field: "description", message: "description is required for the primary locale" })
      }
    }
  })

  return { ok: violations.length === 0, violations }
}

type ParsedEntries = { entries: MetadataEntry[] } | { error: string }

/** Extract the content of the first fenced ```json code block, if any. */
function extractJsonBlock(text: string): string | undefined {
  const match = /```json\s*([\s\S]*?)```/i.exec(text)
  return match ? match[1].trim() : undefined
}

function isMetadataEntryArray(value: unknown): value is MetadataEntry[] {
  return Array.isArray(value) && value.every((e) => e !== null && typeof e === "object" && typeof (e as any).locale === "string")
}

/**
 * Parse `text` into a metadata-entry array, accepting EITHER a raw JSON array (a `.json` deliverable)
 * OR a markdown deliverable containing a fenced ```json code block with that array (the format the
 * marketing-chief deliverable naturally produces). Tries raw content first, then a fenced block.
 * Never throws — a document that is neither shape (or whose JSON doesn't parse to a locale-entry
 * array) returns a structured `{ error }` so the caller can fail closed instead of crashing.
 */
function parseMetadataEntries(text: string): ParsedEntries {
  const candidates = [text.trim(), extractJsonBlock(text)].filter(
    (candidate): candidate is string => candidate !== undefined && candidate.length > 0,
  )

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (isMetadataEntryArray(parsed)) return { entries: parsed }
    } catch {
      // not valid JSON in this candidate — try the next one
    }
  }

  return {
    error:
      "metadata file is not a valid JSON array of locale entries (checked the raw file content and any fenced ```json code block)",
  }
}

export const AscMetadataValidateTool = Tool.define(
  "asc_metadata_validate",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "asc_metadata_validate",
            patterns: [params.metadataPath ?? "*"],
            always: ["*"],
            metadata: { metadataPath: params.metadataPath },
          })

          const title = "asc_metadata_validate"

          if (params.entries) {
            const result = validateAscMetadata(params.entries)
            return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
          }

          if (!params.metadataPath) {
            const result: AscMetadataResult = {
              ok: false,
              violations: [{ locale: "", field: "params", message: "either metadataPath or entries must be provided" }],
            }
            return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
          }

          // File read is wrapped so ENOENT / permission errors become a structured result rather
          // than an uncaught throw — this tool must never crash the caller regardless of what path
          // it's given.
          let text: string
          try {
            text = readFileSync(params.metadataPath, "utf-8")
          } catch (err: any) {
            const result: AscMetadataResult = {
              ok: false,
              violations: [
                {
                  locale: "",
                  field: "file",
                  message: `metadata file not found or unreadable at "${params.metadataPath}": ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              rawPath: params.metadataPath,
            }
            return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
          }

          const parsed = parseMetadataEntries(text)
          if ("error" in parsed) {
            const result: AscMetadataResult = {
              ok: false,
              violations: [{ locale: "", field: "file", message: parsed.error }],
              rawPath: params.metadataPath,
            }
            return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
          }

          const validated = validateAscMetadata(parsed.entries)
          const result: AscMetadataResult = { ...validated, rawPath: params.metadataPath }
          return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
        }),
    }
  }),
)
