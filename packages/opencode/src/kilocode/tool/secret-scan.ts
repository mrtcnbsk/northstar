// kilocode_change - new file
import { Effect, Schema } from "effect"
import { readFileSync, statSync, readdirSync } from "node:fs"
import path from "node:path"
import * as Tool from "@/tool/tool"
import DESCRIPTION from "./secret-scan.txt"

export const Params = Schema.Struct({
  paths: Schema.Array(Schema.String).annotate({
    description: "File and/or directory paths to scan for hardcoded secrets. Directories are recursed.",
  }),
})
export type Params = Schema.Schema.Type<typeof Params>

export type Finding = {
  file: string
  line: number
  kind: "aws_access_key_id" | "private_key" | "assigned_secret"
  snippet: string
}

export type SecretScanResult = {
  ok: boolean
  findings: Finding[]
  filesScanned: number
  bytesScanned: number
  truncated?: boolean
  skipped?: string[]
}

// Total bytes read across a single scan call is capped to avoid unbounded memory use when a
// caller points this tool at a large directory tree. Once the cap is hit, remaining files are
// skipped and reported via `truncated: true` (and listed in `skipped`) rather than silently
// dropped — see xcode-build.ts's bounded-read discipline for the precedent this follows.
export const MAX_BYTES = 2 * 1024 * 1024

// Directories that are never worth scanning: VCS internals, dependency trees, and build output.
// Recursing into these would waste the byte budget on vendored/generated code that isn't the
// repo's own source, and node_modules/Pods/DerivedData can be enormous.
const SKIP_DIRS = new Set([".git", "node_modules", ".build", "DerivedData", "Pods"])

// Extensions that are unambiguously binary — skipped without even opening the file. This is a
// fast-path optimization; the null-byte sniff below is the authoritative binary detector for
// everything else (e.g. a misnamed binary with a .txt extension).
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".pdf",
  ".zip", ".gz", ".tar", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".m4a", ".wav",
  ".so", ".dylib", ".dll", ".a", ".o", ".class",
  ".exe", ".bin", ".dat", ".db", ".sqlite",
])

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/
const AWS_ACCESS_KEY_ID_RE = /AKIA[0-9A-Z]{16}/
// Key-name + assignment + quoted literal. The key-name group is deliberately narrow (known secret
// field names) rather than matching any identifier — see the scoping note below.
const ASSIGNED_SECRET_RE =
  /(?<key>(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?token))\s*[:=]\s*["'](?<value>[^"']{8,})["']/i

/**
 * Placeholder guard for the assigned-secret pattern. A quoted literal that LOOKS like a secret
 * assignment (right key name, right shape) is still not worth flagging if its value is obviously
 * not a real secret: empty, filler characters, angle-bracket template syntax, a "YOUR_..."-style
 * instruction, common placeholder words, or string interpolation (Swift `\(...)`, shell/JS
 * `${...}`) whose actual value is computed at runtime rather than a literal committed to source.
 * Without this guard, `let token = "YOUR_TOKEN_HERE"` or `let id = "${env.ID}"` would produce a
 * finding on every fixture/template/example file in a repo — pure noise that trains users to
 * ignore the tool's output.
 */
function isPlaceholder(value: string): boolean {
  if (value.length === 0) return true
  const lower = value.toLowerCase()
  if (/^x+$/.test(lower)) return true
  if (/^<.*>$/.test(value)) return true
  if (/^your[_-]/i.test(value)) return true
  if (lower === "changeme" || lower === "todo" || lower === "example") return true
  // Swift interpolation `\(...)` or shell/JS interpolation `${...}` spanning the whole value —
  // the literal is a computed expression, not a hardcoded secret.
  if (/^\\\(.*\)$/.test(value)) return true
  if (/^\$\{.*\}$/.test(value)) return true
  return false
}

/** Redact a matched secret value down to its key name plus the first/last 2 characters, e.g.
 * `apiKey = "sk***45"`. Values shorter than 4 characters (should not happen given the >= 8 length
 * gate on ASSIGNED_SECRET_RE, but guarded defensively) fully mask instead of exposing overlap. */
function redactAssignment(key: string, value: string): string {
  if (value.length < 4) return `${key} = "***"`
  const head = value.slice(0, 2)
  const tail = value.slice(-2)
  return `${key} = "${head}***${tail}"`
}

function redactAwsKey(value: string): string {
  return `AKIA***${value.slice(-4)}`
}

/**
 * Pure scanner: scans line-by-line for hardcoded secrets. No I/O — safe to unit test directly.
 *
 * Scoping decision: this intentionally does NOT do generic high-entropy-string detection. An
 * entropy scanner flags any sufficiently "random-looking" string, which in practice means it
 * fires constantly on content that is not a secret at all — hashes, UUIDs, base64-encoded
 * non-secret blobs, minified identifiers, etc. That noise trains users to ignore findings, which
 * defeats the tool's purpose. Instead this sticks to two precise signal classes: known secret
 * *prefixes* (AWS access key ids, PEM private key headers) and *name-assignment context* (a
 * variable/key whose name says "this is a secret" holding a quoted literal). Both are much lower
 * false-positive-rate than raw entropy, at the cost of missing secrets that don't match either
 * shape (e.g. a random API token pasted into a comment with no assignment). That's an accepted
 * tradeoff for a conservative, low-noise first pass.
 */
export function scanText(text: string, filename: string): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineNo = i + 1

    if (PRIVATE_KEY_RE.test(line)) {
      findings.push({ file: filename, line: lineNo, kind: "private_key", snippet: "-----BEGIN [...] PRIVATE KEY-----" })
      continue
    }

    const awsMatch = AWS_ACCESS_KEY_ID_RE.exec(line)
    if (awsMatch) {
      findings.push({
        file: filename,
        line: lineNo,
        kind: "aws_access_key_id",
        snippet: redactAwsKey(awsMatch[0]),
      })
      continue
    }

    const assignedMatch = ASSIGNED_SECRET_RE.exec(line)
    if (assignedMatch?.groups) {
      const { key, value } = assignedMatch.groups
      if (!isPlaceholder(value)) {
        findings.push({
          file: filename,
          line: lineNo,
          kind: "assigned_secret",
          snippet: redactAssignment(key, value),
        })
      }
    }
  }

  return findings
}

/** Sniff the first bytes of a buffer for a null byte — the standard cheap heuristic for "this is
 * binary, not text" (text files essentially never contain NUL). Used as a fallback for files
 * whose extension isn't in the known-binary list (e.g. a misnamed or extensionless binary). */
function looksBinary(buf: Buffer): boolean {
  const sniffLen = Math.min(buf.length, 8000)
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

type ResolvedFile = { path: string }

/** Bounded, skip-aware directory walk. Recurses into directories (skipping SKIP_DIRS), collects
 * candidate file paths. Never throws: an unreadable directory entry is simply omitted, and the
 * caller's per-file read is separately wrapped for the same reason. */
function walk(root: string, skipped: string[]): ResolvedFile[] {
  const out: ResolvedFile[] = []
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(root)
  } catch {
    skipped.push(`${root} (unreadable)`)
    return out
  }

  if (stat.isFile()) {
    out.push({ path: root })
    return out
  }

  if (!stat.isDirectory()) {
    skipped.push(`${root} (not a regular file or directory)`)
    return out
  }

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    skipped.push(`${root} (unreadable directory)`)
    return out
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = path.join(root, entry)
    let entryStat: ReturnType<typeof statSync>
    try {
      entryStat = statSync(full)
    } catch {
      skipped.push(`${full} (unreadable)`)
      continue
    }
    if (entryStat.isDirectory()) {
      out.push(...walk(full, skipped))
    } else if (entryStat.isFile()) {
      out.push({ path: full })
    }
  }

  return out
}

/**
 * Resolve `paths` to a flat, bounded list of text files to scan, then scan each. Enforces the
 * MAX_BYTES total-read cap across the whole call — once hit, remaining candidate files are
 * skipped (recorded, not silently dropped) and `truncated: true` is set. Every filesystem
 * operation is wrapped so an unreadable path degrades to a skip note rather than a throw.
 */
export function scanPaths(paths: readonly string[]): SecretScanResult {
  const skipped: string[] = []
  const candidates: ResolvedFile[] = []
  for (const p of paths) {
    candidates.push(...walk(p, skipped))
  }

  const findings: Finding[] = []
  let filesScanned = 0
  let bytesScanned = 0
  let truncated = false

  for (const candidate of candidates) {
    const ext = path.extname(candidate.path).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) {
      skipped.push(`${candidate.path} (binary extension)`)
      continue
    }

    let size: number
    try {
      size = statSync(candidate.path).size
    } catch {
      skipped.push(`${candidate.path} (unreadable)`)
      continue
    }

    if (bytesScanned + size > MAX_BYTES) {
      truncated = true
      skipped.push(`${candidate.path} (skipped: 2MB scan cap reached)`)
      continue
    }

    let buf: Buffer
    try {
      buf = readFileSync(candidate.path)
    } catch (err) {
      skipped.push(`${candidate.path} (read failed: ${err instanceof Error ? err.message : String(err)})`)
      continue
    }

    if (looksBinary(buf)) {
      skipped.push(`${candidate.path} (binary content)`)
      continue
    }

    bytesScanned += buf.length
    filesScanned += 1
    findings.push(...scanText(buf.toString("utf-8"), candidate.path))
  }

  return {
    ok: findings.length === 0,
    findings,
    filesScanned,
    bytesScanned,
    ...(truncated ? { truncated: true } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  }
}

export const SecretScanTool = Tool.define(
  "secret_scan",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "secret_scan",
            patterns: params.paths.length ? [...params.paths] : ["*"],
            always: ["*"],
            metadata: { paths: params.paths },
          })

          const title = "secret_scan"

          // scanPaths never throws (every fs op inside is wrapped), but this outer try/catch is a
          // last-resort guard so this tool truly never crashes the caller regardless of input.
          let result: SecretScanResult
          try {
            result = scanPaths(params.paths)
          } catch (err) {
            result = {
              ok: false,
              findings: [],
              filesScanned: 0,
              bytesScanned: 0,
              skipped: [`scan failed: ${err instanceof Error ? err.message : String(err)}`],
            }
          }

          return { title, output: JSON.stringify(result), metadata: { ok: result.ok } }
        }),
    }
  }),
)
