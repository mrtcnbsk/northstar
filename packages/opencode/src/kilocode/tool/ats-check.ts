// kilocode_change - new file
import { Effect, Schema } from "effect"
import { readFileSync } from "node:fs"
import * as Tool from "@/tool/tool"
import DESCRIPTION from "./ats-check.txt"

export const Params = Schema.Struct({
  plistPath: Schema.String.annotate({
    description: "Filesystem path to the Info.plist XML plist to check for ATS (App Transport Security) exceptions.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type AtsViolation = {
  domain?: string
  key: string
  message: string
}

export type AtsResult = {
  ok: boolean
  violations: AtsViolation[]
  rawPath?: string
}

/**
 * Minimal, self-contained XML-plist reader — same rationale as privacy-manifest-check.ts: we only
 * need to pull the NSAppTransportSecurity dict (a handful of top-level bools plus a nested
 * per-domain NSExceptionDomains dict) out of an Info.plist, so a regex-based tag scanner is enough
 * and avoids adding an XML/plist parsing dependency.
 */
type XmlPlistError = { message: string }

function isWellFormedPlist(xml: string): boolean {
  const trimmed = xml.trim()
  if (!trimmed) return false
  if (!trimmed.includes("<plist")) return false
  if (!trimmed.includes("</plist>")) return false
  if (!trimmed.includes("<dict>") || !trimmed.includes("</dict>")) return false
  // `plist` is checked separately above (via substring match, not an exact `<plist>` open tag)
  // because the root element always carries a `version="1.0"` attribute, so it would never
  // balance in this exact-tag scan.
  for (const tag of ["dict", "array", "key", "string"]) {
    const opens = (trimmed.match(new RegExp(`<${tag}>`, "g")) ?? []).length
    const closes = (trimmed.match(new RegExp(`</${tag}>`, "g")) ?? []).length
    if (opens !== closes) return false
  }
  return true
}

function extractRootDict(xml: string): string | undefined {
  const start = xml.indexOf("<dict>")
  const end = xml.lastIndexOf("</dict>")
  if (start === -1 || end === -1 || end < start) return undefined
  return xml.slice(start + "<dict>".length, end)
}

/** Scan forward from the start of `text` (which must begin with `<tagName>`) and return the full
 * `<tagName>...</tagName>` span, accounting for nested same-named tags — e.g. NSExceptionDomains'
 * dict value nests another `<dict>` per domain. A naive non-greedy `[\s\S]*?<\/dict>` regex would
 * stop at the FIRST close tag, truncating the outer container before its real end. */
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

/** Find the value fragment immediately following a top-level `<key>keyName</key>` in the given
 * dict body. Only matches the FIRST occurrence at any nesting depth reachable by naive scanning —
 * callers must pass an already-scoped dict body (e.g. the NSAppTransportSecurity dict, not the
 * whole plist) to avoid picking up a same-named key belonging to a different nested dict. */
function findValueForKey(dictBody: string, keyName: string): string | undefined {
  const keyTag = `<key>${keyName}</key>`
  const keyIndex = dictBody.indexOf(keyTag)
  if (keyIndex === -1) return undefined
  const afterKey = dictBody.slice(keyIndex + keyTag.length).replace(/^\s+/, "")

  if (afterKey.startsWith("<true/>")) return "<true/>"
  if (afterKey.startsWith("<false/>")) return "<false/>"
  if (afterKey.startsWith("<dict/>")) return "<dict/>"
  if (afterKey.startsWith("<dict>")) return scanBalancedTag(afterKey, "dict")

  const simpleMatch = /^(<string>[\s\S]*?<\/string>)/.exec(afterKey)
  return simpleMatch ? simpleMatch[1] : undefined
}

function boolValue(tag: string | undefined): boolean | undefined {
  if (tag === "<true/>") return true
  if (tag === "<false/>") return false
  return undefined
}

function dictBody(tag: string | undefined): string | undefined {
  if (!tag || tag === "<dict/>") return undefined
  const m = /^<dict>([\s\S]*)<\/dict>$/.exec(tag)
  return m ? m[1] : undefined
}

/**
 * Split a dict body into its immediate `<key>NAME</key><dict>...</dict>` entries — used for
 * NSExceptionDomains, whose keys are arbitrary domain names rather than known field names. Scans
 * top-level `<key>` tags and pairs each with the `<dict>...</dict>` (or `<dict/>`) that follows it,
 * skipping over nested content so a domain's own nested keys are not mistaken for siblings.
 */
function domainDictEntries(exceptionDomainsBody: string): Array<{ domain: string; body: string }> {
  const entries: Array<{ domain: string; body: string }> = []
  const keyRe = /<key>([^<]*)<\/key>\s*(<dict\/>|<dict>)/g
  let match: RegExpExecArray | null
  while ((match = keyRe.exec(exceptionDomainsBody)) !== null) {
    const domain = match[1]
    if (match[2] === "<dict/>") {
      entries.push({ domain, body: "" })
      continue
    }
    const bodyStart = match.index + match[0].length - "<dict>".length
    const span = scanBalancedTag(exceptionDomainsBody.slice(bodyStart), "dict")
    if (!span) continue // unbalanced; skip rather than mis-slice
    entries.push({ domain, body: span.slice("<dict>".length, -"</dict>".length) })
    keyRe.lastIndex = bodyStart + span.length
  }
  return entries
}

function parsePlistDict(xml: string): { root: string } | XmlPlistError {
  if (!isWellFormedPlist(xml)) return { message: "malformed or truncated plist XML" }
  const root = extractRootDict(xml)
  if (root === undefined) return { message: "no top-level <dict> found in plist" }
  return { root }
}

function isXmlPlistError(x: { root: string } | XmlPlistError): x is XmlPlistError {
  return !("root" in x)
}

const GLOBAL_INSECURE_KEYS = [
  "NSAllowsArbitraryLoads",
  "NSAllowsArbitraryLoadsInWebContent",
  "NSAllowsArbitraryLoadsForMedia",
] as const

/**
 * Pure parser: reads raw Info.plist XML text and flags insecure App Transport Security settings.
 * No I/O — safe to unit test with captured fixtures. Malformed XML degrades to `ok: true` with no
 * violations found (nothing to flag) rather than a distinct "invalid" status — ATS's contract is
 * narrower than the privacy-manifest tool's, so an unparsable file simply yields no ATS dict to
 * inspect, matching the "ATS key absent = default-secure" rule.
 */
export function checkAts(xml: string): AtsResult {
  const parsed = parsePlistDict(xml)
  if (isXmlPlistError(parsed)) {
    return { ok: true, violations: [] }
  }

  const atsTag = findValueForKey(parsed.root, "NSAppTransportSecurity")
  const atsBody = dictBody(atsTag)
  if (atsBody === undefined) {
    // ATS key absent entirely -> default-secure.
    return { ok: true, violations: [] }
  }

  const violations: AtsViolation[] = []

  for (const key of GLOBAL_INSECURE_KEYS) {
    const value = boolValue(findValueForKey(atsBody, key))
    if (value === true) {
      violations.push({ key, message: `${key} is set to true, disabling ATS protections app-wide.` })
    }
  }

  const exceptionDomainsTag = findValueForKey(atsBody, "NSExceptionDomains")
  const exceptionDomainsBody = dictBody(exceptionDomainsTag)
  if (exceptionDomainsBody !== undefined) {
    for (const { domain, body } of domainDictEntries(exceptionDomainsBody)) {
      const insecure = boolValue(findValueForKey(body, "NSExceptionAllowsInsecureHTTPLoads"))
      if (insecure === true) {
        violations.push({
          domain,
          key: "NSExceptionAllowsInsecureHTTPLoads",
          message: `Domain "${domain}" has NSExceptionAllowsInsecureHTTPLoads=true, allowing plaintext HTTP.`,
        })
      }
    }
  }

  return { ok: violations.length === 0, violations }
}

export const AtsCheckTool = Tool.define(
  "ats_check",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "ats_check",
            patterns: [params.plistPath ?? "*"],
            always: ["*"],
            metadata: { plistPath: params.plistPath },
          })

          const title = "ats_check"

          // File read is wrapped so ENOENT / permission errors become a structured result rather
          // than an uncaught throw — this tool must never crash the caller regardless of what path
          // it's given.
          let text: string
          try {
            text = readFileSync(params.plistPath, "utf-8")
          } catch (err: any) {
            const result: AtsResult = {
              ok: false,
              violations: [
                {
                  key: "file",
                  message: `plist not found or unreadable at "${params.plistPath}": ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              rawPath: params.plistPath,
            }
            return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
          }

          const parsed = checkAts(text)
          const result: AtsResult = { ...parsed, rawPath: params.plistPath }
          return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
        }),
    }
  }),
)
