#!/usr/bin/env bun
// kilocode_change - new file

export type BrandSource = { file: string; text: string }
export type BrandHit = { file: string; line: number; pattern: string }
export type BrandRule = { pattern: RegExp; label: string }

export const VISIBLE_ROOTS = [
  "packages/opencode/src/cli/",
  "packages/opencode/src/kilocode/",
  "packages/kilo-console/src/",
  "packages/kilo-vscode/package.json",
  "packages/kilo-vscode/src/",
  "packages/kilo-vscode/webview-ui/",
  "packages/kilo-jetbrains/frontend/src/main/",
  "packages/kilo-jetbrains/src/main/resources/",
] as const

const rules: BrandRule[] = [
  { pattern: /Kilo Code/g, label: "Kilo Code" },
  { pattern: /Kilo CLI/g, label: "Kilo CLI" },
  {
    pattern: /\bkilo (?:--[a-z-]+|run|serve|upgrade|auth|models|mcp|agent|github|debug|tui|daemon)\b/g,
    label: "kilo command",
  },
  { pattern: /\bKilo\b/g, label: "Kilo" },
]

function commentStart(line: string) {
  const block = line.indexOf("/*")
  let from = 0
  while (true) {
    const slash = line.indexOf("//", from)
    if (slash < 0) return block
    if (line[slash - 1] !== ":") return block < 0 ? slash : Math.min(block, slash)
    from = slash + 2
  }
}

function inUrl(line: string, start: number, end: number) {
  for (const match of line.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    const left = match.index
    const right = left + match[0].length
    if (start >= left && end <= right) return true
  }
  return false
}

function ignored(line: string, start: number, end: number) {
  const trimmed = line.trimStart()
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#")
  ) {
    return true
  }
  const comment = commentStart(line)
  if (comment >= 0 && comment <= start) return true
  if (inUrl(line, start, end)) return true
  if (/^(?:import|export .* from)\b/.test(trimmed)) return true
  if (/['"](?:X-Title|x-title|User-Agent|X-Cerebras-3rd-Party-Integration)['"]\s*:/.test(line)) return true
  if (/\buses:\s*Kilo-Org\//.test(line)) return true
  if (line.slice(start).startsWith("Kilo-Org/")) return true
  if (line.slice(Math.max(0, start - 1), start) === "." || line.slice(end, end + 1) === ".") return true
  if (line.includes("[Kilo New]")) return true
  return false
}

type Candidate = BrandHit & { start: number; end: number }

function candidates(sources: BrandSource[]) {
  const hits: Candidate[] = []
  for (const source of sources) {
    if (/(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.)/.test(source.file)) continue
    if (source.file.endsWith("/legacy-migration/native-mode-defaults.ts")) continue
    const lines = source.text.split("\n")
    for (const [index, line] of lines.entries()) {
      const found: { start: number; end: number; pattern: string }[] = []
      for (const rule of rules) {
        rule.pattern.lastIndex = 0
        for (const match of line.matchAll(rule.pattern)) {
          const start = match.index
          const end = start + match[0].length
          if (ignored(line, start, end)) continue
          found.push({ start, end, pattern: match[0] })
        }
      }
      found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
      const accepted: typeof found = []
      for (const item of found) {
        if (accepted.some((hit) => item.start >= hit.start && item.end <= hit.end)) continue
        accepted.push(item)
        hits.push({ file: source.file, line: index + 1, pattern: item.pattern, start: item.start, end: item.end })
      }
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.start - b.start)
}

export function scanVisibleBrand(sources: BrandSource[]): BrandHit[] {
  return candidates(sources).map((hit) => ({ file: hit.file, line: hit.line, pattern: hit.pattern }))
}

export function rewriteVisibleBrand(source: BrandSource) {
  const lines = source.text.split("\n")
  const hits = candidates([source]).sort((a, b) => b.line - a.line || b.start - a.start)
  for (const hit of hits) {
    const index = hit.line - 1
    const line = lines[index]
    if (line === undefined) continue
    const replacement = hit.pattern.startsWith("kilo ") ? `northstar ${hit.pattern.slice(5)}` : "Northstar"
    lines[index] = line.slice(0, hit.start) + replacement + line.slice(hit.end)
  }
  return lines.join("\n")
}
