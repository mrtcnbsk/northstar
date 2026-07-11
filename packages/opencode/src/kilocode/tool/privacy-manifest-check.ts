// kilocode_change - new file
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import * as Tool from "@/tool/tool"
import DESCRIPTION from "./privacy-manifest-check.txt"

export const Params = Schema.Struct({
  manifestPath: Schema.String.annotate({
    description: "Filesystem path to the PrivacyInfo.xcprivacy XML plist to check.",
  }),
  requiredReasonAPIs: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Required Reason API category codes the app is known to use (e.g. NSPrivacyAccessedAPICategoryFileTimestamp). Each must be declared in the manifest with at least one non-empty reason.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type PrivacyViolation = {
  api?: string
  key?: string
  message: string
}

export type PrivacyManifestResult = {
  ok: boolean
  status: "ok" | "missing_manifest" | "invalid"
  violations: PrivacyViolation[]
  rawPath?: string
  /** The manifest's declared NSPrivacyTracking value, when parseable. Informational only — it does
   * not currently drive any violation (the tool's contract only covers Required Reason API
   * declarations), but is surfaced since callers may want to sanity-check it against reality. */
  tracking?: boolean
}

/**
 * Minimal, self-contained XML-plist reader — NOT a general plist parser. We only need to pull a
 * small, known set of keys out of a `<dict>` (top-level bools, and the `NSPrivacyAccessedAPITypes`
 * array of `{type, reasons[]}` dicts), so a full DOM/XML library is unnecessary weight. Instead we
 * regex-scan for the specific `<key>...</key>` / value-tag pairs we care about, tolerating
 * whitespace and attribute-free plist XML (Apple's plist output is always this shape).
 *
 * This is deliberately narrow: it will not handle nested arrays-of-arrays, CDATA, or exotic plist
 * value types. That's fine — privacy manifests and Info.plist ATS blocks only ever use the small
 * subset of plist grammar (dict/array/string/true/false) this parser understands.
 */
type XmlPlistError = { message: string }

/** Very small tag tokenizer: walks the XML looking for the tags plist uses. Not a validating XML
 * parser — it does not check tag nesting is well-formed beyond "every opening tag we care about
 * has a matching close tag somewhere ahead". That is enough to detect the truncated/malformed
 * case (a plist cut off mid-document, e.g. missing `</plist>`) without pulling in an XML library. */
function isWellFormedPlist(xml: string): boolean {
  const trimmed = xml.trim()
  if (!trimmed) return false
  if (!trimmed.includes("<plist")) return false
  if (!trimmed.includes("</plist>")) return false
  if (!trimmed.includes("<dict>") || !trimmed.includes("</dict>")) return false
  // Balanced-tag sanity check for the tags this parser actually walks. A mismatch here means the
  // document was truncated or hand-edited into invalid XML. `plist` is checked separately above
  // (via `<plist` / `</plist>` substring, not an exact `<plist>` open tag) because the root
  // element always carries a `version="1.0"` attribute, so it would never balance here.
  for (const tag of ["dict", "array", "key", "string"]) {
    const opens = (trimmed.match(new RegExp(`<${tag}>`, "g")) ?? []).length
    const closes = (trimmed.match(new RegExp(`</${tag}>`, "g")) ?? []).length
    if (opens !== closes) return false
  }
  return true
}

/** Extract the text content of the first top-level `<dict>...</dict>` block (the plist root). */
function extractRootDict(xml: string): string | undefined {
  const start = xml.indexOf("<dict>")
  const end = xml.lastIndexOf("</dict>")
  if (start === -1 || end === -1 || end < start) return undefined
  return xml.slice(start + "<dict>".length, end)
}

/** Scan forward from `openTag` (e.g. "<array>") immediately at the start of `text` and return the
 * full `<tag>...</tag>` span, accounting for nested same-named tags (an array of arrays, or — the
 * case that actually matters here — an array of dicts each containing their own nested array). A
 * naive non-greedy `[\s\S]*?<\/array>` regex would stop at the FIRST close tag, truncating outer
 * containers that hold nested same-named containers; this walks tag-by-tag instead. */
function scanBalancedTag(text: string, tagName: string): string | undefined {
  const openTag = `<${tagName}>`
  const closeTag = `</${tagName}>`
  if (!text.startsWith(openTag)) return undefined
  const tokenRe = new RegExp(`${openTag}|${closeTag}`, "g")
  tokenRe.lastIndex = 0
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(text)) !== null) {
    if (match[0] === openTag) depth++
    else depth--
    if (depth === 0) return text.slice(0, tokenRe.lastIndex)
  }
  return undefined // unbalanced; caller treats as absent
}

/** Find the value fragment immediately following a `<key>keyName</key>` at the top level of the
 * given dict body. Returns the raw value tag text (e.g. `<true/>`, `<false/>`, `<array>...</array>`,
 * `<string>...</string>`), or undefined if the key is absent. */
function findValueForKey(dictBody: string, keyName: string): string | undefined {
  const keyTag = `<key>${keyName}</key>`
  const keyIndex = dictBody.indexOf(keyTag)
  if (keyIndex === -1) return undefined
  const afterKey = dictBody.slice(keyIndex + keyTag.length).replace(/^\s+/, "")

  if (afterKey.startsWith("<true/>")) return "<true/>"
  if (afterKey.startsWith("<false/>")) return "<false/>"
  if (afterKey.startsWith("<array/>")) return "<array/>"
  if (afterKey.startsWith("<dict/>")) return "<dict/>"
  if (afterKey.startsWith("<array>")) return scanBalancedTag(afterKey, "array")
  if (afterKey.startsWith("<dict>")) return scanBalancedTag(afterKey, "dict")

  const simpleMatch = /^(<string>[\s\S]*?<\/string>|<integer>[\s\S]*?<\/integer>)/.exec(afterKey)
  return simpleMatch ? simpleMatch[1] : undefined
}

function boolValue(tag: string | undefined): boolean | undefined {
  if (tag === "<true/>") return true
  if (tag === "<false/>") return false
  return undefined
}

/** Split an `<array>...</array>` tag's inner text into its immediate child `<dict>...</dict>`
 * element bodies (not recursing further) — used for NSPrivacyAccessedAPITypes' array-of-dicts.
 * Uses the balanced-tag scanner per entry so a dict that itself nests another `<dict>` (not
 * expected for this manifest shape today, but cheap to get right) is not mis-sliced. */
function arrayOfDictBodies(arrayTag: string | undefined): string[] {
  if (!arrayTag || arrayTag === "<array/>") return []
  const inner = arrayTag.replace(/^<array>/, "").replace(/<\/array>$/, "")
  const bodies: string[] = []
  let cursor = 0
  while (true) {
    const nextDict = inner.indexOf("<dict>", cursor)
    if (nextDict === -1) break
    const span = scanBalancedTag(inner.slice(nextDict), "dict")
    if (!span) break // unbalanced; stop rather than mis-slice
    bodies.push(span.slice("<dict>".length, -"</dict>".length))
    cursor = nextDict + span.length
  }
  return bodies
}

/** Split an `<array>...</array>` tag's inner text into its `<string>...</string>` values. */
function arrayOfStrings(arrayTag: string | undefined): string[] {
  if (!arrayTag || arrayTag === "<array/>") return []
  const inner = arrayTag.replace(/^<array>/, "").replace(/<\/array>$/, "")
  const values: string[] = []
  const re = /<string>([\s\S]*?)<\/string>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(inner)) !== null) {
    values.push(m[1])
  }
  return values
}

function stringValue(tag: string | undefined): string | undefined {
  if (!tag) return undefined
  const m = /^<string>([\s\S]*?)<\/string>$/.exec(tag)
  return m ? m[1] : undefined
}

export type ParsedApiType = {
  type: string
  reasons: string[]
}

export type ParsedPrivacyManifest = {
  tracking?: boolean
  accessedApiTypes: ParsedApiType[]
}

/** Parse the plist XML into the small structured shape this tool cares about. Throws (as a plain
 * object, not an Error subclass — the caller wraps this) when the document is not well-formed. */
function parsePlistDict(xml: string): { root: string } | XmlPlistError {
  if (!isWellFormedPlist(xml)) return { message: "malformed or truncated plist XML" }
  const root = extractRootDict(xml)
  if (root === undefined) return { message: "no top-level <dict> found in plist" }
  return { root }
}

function isXmlPlistError(x: { root: string } | XmlPlistError): x is XmlPlistError {
  return !("root" in x)
}

/**
 * Pure parser: reads raw PrivacyInfo.xcprivacy XML text and produces a structured compliance
 * result. No I/O — safe to unit test with captured fixtures.
 */
export function parsePrivacyManifest(
  xml: string,
  requiredReasonAPIs?: readonly string[],
): PrivacyManifestResult {
  const parsed = parsePlistDict(xml)
  if (isXmlPlistError(parsed)) {
    return {
      ok: false,
      status: "invalid",
      violations: [{ message: `Could not parse privacy manifest: ${parsed.message}` }],
    }
  }

  const tracking = boolValue(findValueForKey(parsed.root, "NSPrivacyTracking"))
  const apiTypesArrayTag = findValueForKey(parsed.root, "NSPrivacyAccessedAPITypes")
  const apiTypeDicts = arrayOfDictBodies(apiTypesArrayTag)

  const accessedApiTypes: ParsedApiType[] = apiTypeDicts.map((body) => {
    const type = stringValue(findValueForKey(body, "NSPrivacyAccessedAPIType")) ?? ""
    const reasonsTag = findValueForKey(body, "NSPrivacyAccessedAPITypeReasons")
    const reasons = arrayOfStrings(reasonsTag)
    return { type, reasons }
  })

  const violations: PrivacyViolation[] = []

  // Any declared API with empty reasons is a violation, independent of requiredReasonAPIs.
  for (const entry of accessedApiTypes) {
    if (entry.reasons.length === 0) {
      violations.push({
        api: entry.type,
        message: `Declared API "${entry.type}" has no NSPrivacyAccessedAPITypeReasons declared.`,
      })
    }
  }

  // Every API the caller says the app actually uses must be declared with at least one reason.
  if (requiredReasonAPIs) {
    const declaredWithReasons = new Set(accessedApiTypes.filter((e) => e.reasons.length > 0).map((e) => e.type))
    for (const required of requiredReasonAPIs) {
      if (!declaredWithReasons.has(required)) {
        const isDeclaredAtAll = accessedApiTypes.some((e) => e.type === required)
        violations.push({
          api: required,
          message: isDeclaredAtAll
            ? `Required Reason API "${required}" is declared but has no reasons (already flagged above).`
            : `Required Reason API "${required}" is used by the app but not declared in NSPrivacyAccessedAPITypes.`,
        })
      }
    }
  }

  return {
    ok: violations.length === 0,
    status: "ok",
    violations,
    ...(tracking !== undefined ? { tracking } : {}),
  }
}

export const PrivacyManifestCheckTool = Tool.define(
  "privacy_manifest_check",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "privacy_manifest_check",
            patterns: [params.manifestPath ?? "*"],
            always: ["*"],
            metadata: { manifestPath: params.manifestPath },
          })

          const title = "privacy_manifest_check"

          // File read is wrapped so ENOENT / permission errors become a structured result rather
          // than an uncaught throw — this tool must never crash the caller regardless of what path
          // it's given.
          let text: string
          try {
            text = readFileSync(params.manifestPath, "utf-8")
          } catch (err: any) {
            const isMissing = err && (err.code === "ENOENT" || err.code === "ENOTDIR")
            const result: PrivacyManifestResult = {
              ok: false,
              status: isMissing ? "missing_manifest" : "invalid",
              violations: [
                {
                  message: isMissing
                    ? `Privacy manifest not found at "${params.manifestPath}".`
                    : `Could not read privacy manifest at "${params.manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              rawPath: params.manifestPath,
            }
            return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
          }

          const parsed = parsePrivacyManifest(text, params.requiredReasonAPIs)
          const result: PrivacyManifestResult = { ...parsed, rawPath: params.manifestPath }
          return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
        }),
    }
  }),
)
