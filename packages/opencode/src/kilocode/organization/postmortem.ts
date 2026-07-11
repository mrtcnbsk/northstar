// kilocode_change - new file
import path from "path"
import { Filesystem } from "../../util/filesystem"
import { OrgAudit } from "./audit"
import { OrgState } from "./state"

/**
 * Deterministic post-run postmortem (W6.2). `build` is a PURE function of its inputs (a
 * completed/halted `OrgState.Run`, its `OrgState.runSummary`, and its `OrgAudit.Entry[]` trail):
 * no LLM, no network, no clock reads. The same input always produces the exact same markdown
 * string - cheap to unit test and safe to call from the lock-held run-end choke points in
 * `tools.ts`. Qualitative, LLM-narrated lessons are an explicit non-goal of v1 (see the wave 6
 * plan's locked decision #1); this only ever restates structured run state.
 *
 * `write` appends the built section to `<projectDir>/.kilo/org/lessons.md`, growing the file with
 * the newest section LAST (a simple append-only log matching lessons.md's "read top-to-bottom
 * chronologically" intent - not a bounded ring; that's a possible follow-up if the file grows
 * large).
 *
 * Idempotency / fire-once: each section's first line is a stable HTML-comment marker,
 * `<!-- postmortem:<runID> -->`. Before appending, `write` checks whether the FILE ALREADY
 * CONTAINS that exact marker string and no-ops if so. This is the actual fire-once guarantee -
 * `tools.ts`'s choke points call the shared best-effort recorder on every run-ending
 * `org_advance`/`org_decision`/`org_stop` call, INCLUDING a re-entrant `org_advance` on an
 * already-completed/halted run (the runner's early-exit at the top of `advance` still returns
 * `{done: true}`/`{halted: ...}` on every subsequent call), so "the state transition only happens
 * once" is not by itself enough to guarantee a single lessons.md section; this marker check is
 * what actually prevents the double-append.
 */
export namespace OrgPostmortem {
  export function lessonsPath(projectDir: string): string {
    return path.join(projectDir, ".kilo", "org", "lessons.md")
  }

  function marker(runID: string): string {
    return `<!-- postmortem:${runID} -->`
  }

  /**
   * The stage most representative of the run's outcome: the failed stage (a retry-exhausted
   * halt), else the no-go'd stage (a human rejection), else the last stage in pipeline order (a
   * clean ship). Used both by `outcome` (to name the responsible stage in a halt) and by
   * `tools.ts` as the `dept` tag on the companion OrgMemory lesson.
   */
  export function keyStage(run: OrgState.Run): string {
    const entries = Object.entries(run.stages)
    const failed = entries.find(([, s]) => s.status === "failed")
    if (failed) return failed[0]
    const noGo = entries.find(([, s]) => s.decision === "no-go")
    if (noGo) return noGo[0]
    return entries.at(-1)?.[0] ?? "unknown"
  }

  /** One-line outcome: "shipped" | "no-go at <stage>: <note>" | "halted at <stage>: <reason>". */
  export function outcome(run: OrgState.Run): string {
    if (run.status === "completed") return "shipped"
    const reason = run.haltReason ?? "no reason recorded"
    // OrgRunner.decide's no-go branch already writes haltReason as `no-go at <stage>[: <note>]`
    // (runner.ts's `decide`), so a no-go halt is already the exact one-liner we want.
    if (reason.startsWith("no-go at")) return reason
    return `halted at ${keyStage(run)}: ${reason}`
  }

  /**
   * The run's "end time": the latest ISO timestamp across every stage's `completedAt` and every
   * audit entry's `ts`, derived purely from the inputs (no `Date.now()` read, keeping `build`
   * pure and its output reproducible from the same run/audit snapshot).
   */
  function endTime(run: OrgState.Run, audit: OrgAudit.Entry[]): string | undefined {
    const stamps = [
      ...Object.values(run.stages)
        .map((s) => s.completedAt)
        .filter((t): t is string => !!t),
      ...audit.map((e) => e.ts),
    ]
    if (stamps.length === 0) return undefined
    return stamps.reduce((latest, t) => (Date.parse(t) > Date.parse(latest) ? t : latest))
  }

  export function build(
    run: OrgState.Run,
    summary: ReturnType<typeof OrgState.runSummary>,
    audit: OrgAudit.Entry[],
  ): string {
    const lines: string[] = []
    lines.push(marker(run.runID))
    lines.push(`## ${run.runID} — ${run.idea}`)
    lines.push("")
    lines.push(`- status: ${run.status}${run.haltReason ? ` (${run.haltReason})` : ""}`)
    lines.push(`- started: ${run.createdAt}`)
    const ended = endTime(run, audit)
    if (ended) lines.push(`- ended: ${ended}`)
    lines.push(`- total cost: $${summary.totalCost}`)
    lines.push(`- outcome: ${outcome(run)}`)
    lines.push("")
    lines.push("| stage | status | cost | attempts | decision |")
    lines.push("| --- | --- | --- | --- | --- |")
    for (const [stage, s] of Object.entries(run.stages)) {
      lines.push(`| ${stage} | ${s.status} | $${OrgState.stageCost(s)} | ${s.attempts} | ${s.decision ?? "-"} |`)
    }
    if (audit.length > 0) {
      lines.push("")
      lines.push("Gate decisions:")
      for (const entry of audit) {
        lines.push(`- ${entry.ts} ${entry.stage}: ${entry.decision}${entry.note ? ` — ${entry.note}` : ""}`)
      }
    }
    lines.push("")
    return lines.join("\n")
  }

  /**
   * Appends the built section to lessons.md, creating the file (and `.kilo/org/`) on first write.
   * Fire-once via the marker check documented above - a second `write` for the same `run.runID`
   * is a pure no-op (byte-identical file before/after). NOT best-effort itself: a real I/O failure
   * (e.g. the destination path is unwritable) rejects normally. The best-effort guarantee lives
   * one layer up, in `tools.ts`'s shared recorder, which wraps this call in try/catch.
   */
  export async function write(
    projectDir: string,
    run: OrgState.Run,
    summary: ReturnType<typeof OrgState.runSummary>,
    audit: OrgAudit.Entry[],
  ): Promise<void> {
    const file = lessonsPath(projectDir)
    const existing = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return ""
        throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    if (existing.includes(marker(run.runID))) return // fire-once: this run's section is already present
    const section = build(run, summary, audit)
    const next = existing.length > 0 ? `${existing}\n${section}` : section
    await Filesystem.write(file, next)
  }
}
