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
    pattern: /\bkilo (?:run|serve|upgrade|auth|models|mcp|agent|github|debug|tui|daemon)\b/g,
    label: "kilo command",
  },
  { pattern: /\bKilo\b/g, label: "Kilo" },
]

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
  if (/^(?:import|export .* from)\b/.test(trimmed)) return true
  if (line.slice(Math.max(0, start - 1), start) === "." || line.slice(end, end + 1) === ".") return true
  if (line.includes("[Kilo New]")) return true
  return false
}

export function scanVisibleBrand(sources: BrandSource[]): BrandHit[] {
  const hits: (BrandHit & { start: number; end: number })[] = []
  for (const source of sources) {
    if (/(?:^|\/)(?:__tests__\/|[^/]+\.(?:test|spec)\.)/.test(source.file)) continue
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
  return hits
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.start - b.start)
    .map((hit) => ({ file: hit.file, line: hit.line, pattern: hit.pattern }))
}
