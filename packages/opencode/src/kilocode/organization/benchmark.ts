// kilocode_change - new file
import path from "path"
import { mkdir } from "node:fs/promises"
import z from "zod"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { OrgSchema } from "./schema"
import { OrgState } from "./state"
import { OrgArtifacts } from "./artifacts"
import { OrgRunner } from "./runner"

/**
 * W8.7: a deterministic, no-LLM fixture-org benchmark harness. `OrgRunner` is already fully
 * deterministic and LLM-free (the LLM only lives in tools.ts's CEO task tool), so this module is
 * ~90% "drive `OrgRunner.advance` with a scripted `costOf`" - it does NOT reimplement any pipeline
 * logic (readiness, budgets, retries, gates, fan-out all stay in runner.ts/state.ts). The harness
 * plays the CEO's role mechanically: on `instruct` it writes a valid deliverable and reports a
 * deterministic taskID; on `gate` it auto-answers via `bench.decisions`; it terminates on
 * `done`/`halted` and evaluates the run against author-declared SLA goals.
 *
 * `benchmark.jsonc` mirrors schema.ts's own parse/validate/load split: zod handles shape, `validate`
 * handles cross-references zod can't express (unknown stage refs, missing sla, org XOR orgPath) as a
 * PURE non-throwing list, and `loadBenchmark` is the thin read -> parseJsonc -> parse -> validate
 * I/O boundary.
 */
export namespace OrgBenchmark {
  export const Sla = z.object({
    /** Total run cost must not exceed this (USD). */
    maxCost: z.number().nonnegative().optional(),
    /** Count of stages the run actually reached (status != "pending") must not exceed this. */
    maxStages: z.number().int().nonnegative().optional(),
    /** The run's final status must equal this. */
    expectStatus: z.enum(["completed", "halted"]).optional(),
    /** No single stage's `attempts` (instruct issuances, including revise re-instructs) may exceed this. */
    maxRetries: z.number().int().nonnegative().optional(),
    /** Every named stage must have produced a validated deliverable during the run. */
    deliverables: z.array(z.string().min(1)).optional(),
  })
  export type Sla = z.output<typeof Sla>

  export const Benchmark = z.object({
    /** Inline organization (mirrors OrgSchema.Organization). Exactly one of `org`/`orgPath` must be set. */
    org: OrgSchema.Organization.optional(),
    /** Path to an organization.jsonc, resolved relative to the benchmark's project dir at run time. */
    orgPath: z.string().min(1).optional(),
    idea: z.string().min(1),
    mode: z.string().optional(),
    /** Scripted per-stage cost (USD), author-friendly: keyed by STAGE NAME, not taskID/session. */
    costs: z.record(z.string(), z.number()),
    /** How to auto-answer a stage's human gate(s). Absent stage defaults to "approve". */
    decisions: z.record(z.string(), z.enum(["approve", "no-go", "revise"])).optional(),
    /** SLA goals evaluated against the run's outcome. Required (possibly `{}`) - see `validate`. */
    sla: Sla.optional(),
  })
  export type Benchmark = z.output<typeof Benchmark>

  export type BenchmarkResult = {
    runID: string
    status: OrgState.Run["status"]
    totalCost: number
    stageCount: number
    perStageAttempts: Record<string, number>
    deliverablesProduced: string[]
    slaViolations: string[]
  }

  export function parse(input: unknown): Benchmark {
    return Benchmark.parse(input)
  }

  /**
   * Structural validation beyond shape, mirroring OrgSchema.validate: PURE, non-throwing, returns
   * an error list. Cross-checks costs/decisions/sla.deliverables stage refs against the org's
   * pipeline - only possible when `org` is inline (an `orgPath` requires I/O to resolve, so that
   * cross-check is skipped and deferred to `runBenchmark`'s own load failure).
   */
  export function validate(bench: Benchmark): string[] {
    const errors: string[] = []
    if (!bench.org && !bench.orgPath) {
      errors.push("benchmark must specify either `org` (inline) or `orgPath`")
    }
    if (bench.org && bench.orgPath) {
      errors.push("benchmark must specify only one of `org` or `orgPath`, not both")
    }
    if (!bench.sla) {
      errors.push("missing `sla` (declare an explicit sla block, `{}` for no goals, so omission reads as intentional)")
    }

    if (bench.org) {
      errors.push(...OrgSchema.validate(bench.org))
    }

    const pipelineStages = bench.org ? new Set(bench.org.pipeline.map((p) => p.stage)) : undefined
    if (pipelineStages) {
      for (const stage of Object.keys(bench.costs)) {
        if (!pipelineStages.has(stage)) errors.push(`costs references unknown stage "${stage}"`)
      }
      for (const stage of Object.keys(bench.decisions ?? {})) {
        if (!pipelineStages.has(stage)) errors.push(`decisions references unknown stage "${stage}"`)
      }
      for (const stage of bench.sla?.deliverables ?? []) {
        if (!pipelineStages.has(stage)) errors.push(`sla.deliverables references unknown stage "${stage}"`)
      }
    }

    return errors
  }

  export async function loadBenchmark(file: string): Promise<Benchmark> {
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new Error(`No benchmark found: expected ${file}.`)
        }
        throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    const parseErrors: ParseError[] = []
    const raw = parseJsonc(text, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length) {
      throw new Error(`Invalid benchmark.jsonc at ${file}: JSONC syntax error (${parseErrors.length} error(s))`)
    }
    let bench: Benchmark
    try {
      bench = parse(raw)
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new Error(`Invalid benchmark.jsonc at ${file}:\n${z.prettifyError(err)}`, { cause: err })
      }
      throw err
    }
    const errors = validate(bench)
    if (errors.length) throw new Error(`Invalid benchmark.jsonc at ${file}:\n- ${errors.join("\n- ")}`)
    return bench
  }

  /** Resolves the benchmark's target org: the inline `org`, or a fresh load from `orgPath` (relative
   * to `projectDir` unless absolute). Applies the same parse+validate gate `loadBenchmark` does. */
  async function resolveOrg(projectDir: string, bench: Benchmark): Promise<OrgSchema.Organization> {
    if (bench.org) return bench.org
    if (!bench.orgPath) throw new Error("benchmark has neither `org` nor `orgPath`")
    const file = path.isAbsolute(bench.orgPath) ? bench.orgPath : path.join(projectDir, bench.orgPath)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        throw new Error(`Failed to read org at ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    const parseErrors: ParseError[] = []
    const raw = parseJsonc(text, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length) throw new Error(`Invalid org at ${file}: JSONC syntax error`)
    const org = OrgSchema.parse(raw)
    const errors = OrgSchema.validate(org)
    if (errors.length) throw new Error(`Invalid org at ${file}:\n- ${errors.join("\n- ")}`)
    return org
  }

  /** Parses the stage name back out of a driver-generated `ses-<stage>-<n>` taskID. Greedy `.+`
   * correctly handles stage names that themselves contain dashes, leaving the trailing `-<digits>`
   * as the sequence number. */
  function stageOfTaskID(taskID: string): string | undefined {
    const m = /^ses-(.+)-(\d+)$/.exec(taskID)
    return m?.[1]
  }

  function nextTaskID(counters: Map<string, number>, stage: string): string {
    const n = (counters.get(stage) ?? 0) + 1
    counters.set(stage, n)
    return `ses-${stage}-${n}`
  }

  function deliverableContent(stage: string, seq: number): string {
    return `# ${stage} deliverable (rev ${seq})\n\n` + "benchmark fixture content ".repeat(10)
  }

  const MAX_ADVANCE_ITERATIONS = 500

  /**
   * Drives a fixture org through the deterministic `OrgRunner` end to end, with NO LLM: `costOf` is
   * a lookup into `bench.costs` keyed by stage (parsed back out of the driver's own deterministic
   * taskID scheme), so it never touches a real chief session. This function plays exactly the role
   * tools.ts's CEO task tool plays for a real run - it drives `OrgRunner.advance`/`decide` and
   * reacts to the `Batch` it returns - without reimplementing any readiness/budget/retry/gate logic.
   *
   * `costOf`'s cumulative-per-session contract (see runner.ts) is honored naturally: a revise or
   * retry re-instruct that carries `resumeTaskID` is reported back verbatim (same session, same
   * `bench.costs` lookup key), while a fresh instruct gets a brand new taskID via `nextTaskID` - so
   * `bench.costs` values are genuinely PER STAGE, not per call.
   *
   * Human gates are auto-answered from `bench.decisions` (default "approve"). A scripted "revise"
   * fires at most ONCE per stage per run (tracked in `revisedOnce`) and then falls back to "approve"
   * on any later gate for that same stage - otherwise a static single-decision script would revise
   * the same stage forever. This still lets a fixture push a stage's `attempts` from 1 to 2 (useful
   * for exercising `sla.maxRetries`) while guaranteeing the run terminates.
   */
  export async function runBenchmark(
    projectDir: string,
    bench: Benchmark,
    emit: (result: BenchmarkResult) => void = () => {},
  ): Promise<BenchmarkResult> {
    const org = await resolveOrg(projectDir, bench)
    const run = await OrgRunner.start(projectDir, org, bench.idea, bench.mode)
    const runID = run.runID

    const taskCounters = new Map<string, number>()
    const deliverableSeq = new Map<string, number>()
    const revisedOnce = new Set<string>()
    const deliverablesProduced: string[] = []
    const deliverablesSeen = new Set<string>()

    const deps: OrgRunner.Deps = {
      costOf: async (taskID) => {
        const stage = stageOfTaskID(taskID)
        return stage ? bench.costs[stage] : undefined
      },
    }

    async function writeDeliverableFor(stage: string) {
      const seq = (deliverableSeq.get(stage) ?? 0) + 1
      deliverableSeq.set(stage, seq)
      const file = OrgArtifacts.deliverablePath(projectDir, runID, stage)
      await mkdir(path.dirname(file), { recursive: true })
      await Bun.write(file, deliverableContent(stage, seq))
      if (!deliverablesSeen.has(stage)) {
        deliverablesSeen.add(stage)
        deliverablesProduced.push(stage)
      }
    }

    let input: { taskID?: string; taskResults?: Array<{ stage: string; taskID: string }> } = {}
    let terminalStatus: OrgState.Run["status"] | undefined

    for (let iter = 0; iter < MAX_ADVANCE_ITERATIONS; iter++) {
      const batch = await OrgRunner.advance(deps, projectDir, org, runID, input)
      input = {}

      if (batch.halted) {
        terminalStatus = "halted"
        break
      }
      if (batch.done) {
        terminalStatus = "completed"
        break
      }

      const taskResults: Array<{ stage: string; taskID: string }> = []
      for (const item of batch.instruct) {
        await writeDeliverableFor(item.stage)
        const taskID = item.resumeTaskID ?? nextTaskID(taskCounters, item.stage)
        taskResults.push({ stage: item.stage, taskID })
      }

      if (batch.gate) {
        let decision = bench.decisions?.[batch.gate.stage] ?? "approve"
        if (decision === "revise") {
          if (revisedOnce.has(batch.gate.stage)) decision = "approve"
          else revisedOnce.add(batch.gate.stage)
        }
        const note =
          decision === "no-go"
            ? "benchmark fixture: scripted no-go"
            : decision === "revise"
              ? "benchmark fixture: scripted revise"
              : undefined
        await OrgRunner.decide(projectDir, org, runID, decision, note)
      }

      if (batch.incomplete) {
        // The driver above always writes a valid deliverable synchronously alongside every instruct,
        // so a genuine "incomplete" here means the fixture is exercising something this harness
        // doesn't script (e.g. a timeoutMs stage, or an unresumable-retry path). Fail fast with a
        // precise reason rather than looping until MAX_ADVANCE_ITERATIONS masks it as a generic hang.
        throw new Error(
          `OrgBenchmark.runBenchmark: unexpected incomplete for stage "${batch.incomplete.stage}" (${batch.incomplete.reason}) - ` +
            `this fixture harness always writes a valid deliverable synchronously and does not script timeoutMs/unresumable-retry scenarios`,
        )
      }

      if (taskResults.length > 0) input = { taskResults }
    }

    if (!terminalStatus) {
      throw new Error(
        `OrgBenchmark.runBenchmark: exceeded ${MAX_ADVANCE_ITERATIONS} advance() iterations without reaching done/halted - check bench.decisions for an unterminated loop`,
      )
    }

    const finalRun = await OrgState.read(projectDir, runID)
    const totalCost = Object.values(finalRun.stages).reduce((sum, s) => sum + OrgState.stageCost(s), 0)
    const stageCount = Object.values(finalRun.stages).filter((s) => s.status !== "pending").length
    const perStageAttempts = Object.fromEntries(
      Object.entries(finalRun.stages).map(([name, s]) => [name, s.attempts]),
    )

    const partial: Omit<BenchmarkResult, "slaViolations"> = {
      runID,
      status: finalRun.status,
      totalCost,
      stageCount,
      perStageAttempts,
      deliverablesProduced,
    }
    const slaViolations = bench.sla ? evaluateSla({ ...partial, slaViolations: [] }, bench.sla) : []
    const result: BenchmarkResult = { ...partial, slaViolations }

    emit(result)
    return result
  }

  /**
   * PURE, non-throwing SLA violation list for a completed `BenchmarkResult`. Boundaries mirror
   * OrgMetrics.health's style (exclusive - a metric exactly AT its ceiling is not a violation).
   * NOTE: the org's own budget ceiling is enforced POST-stage (runner.ts settleRunningStage) - a
   * stage that overshoots still completes and records its real cost before the halt fires, so
   * `result.totalCost` can exceed `sla.maxCost` by that one stage's spend even on a run the org
   * itself correctly halted. That is surfaced here as a real maxCost violation, not suppressed -
   * the whole point of an SLA regression check is to catch exactly this kind of overshoot.
   */
  export function evaluateSla(result: BenchmarkResult, sla: Sla): string[] {
    const violations: string[] = []

    if (sla.maxCost !== undefined && result.totalCost > sla.maxCost) {
      violations.push(`totalCost ${result.totalCost} exceeds maxCost ${sla.maxCost}`)
    }
    if (sla.expectStatus !== undefined && result.status !== sla.expectStatus) {
      violations.push(`status "${result.status}" does not match expected "${sla.expectStatus}"`)
    }
    if (sla.maxStages !== undefined && result.stageCount > sla.maxStages) {
      violations.push(`stageCount ${result.stageCount} exceeds maxStages ${sla.maxStages}`)
    }
    if (sla.maxRetries !== undefined) {
      for (const [stage, attempts] of Object.entries(result.perStageAttempts)) {
        if (attempts > sla.maxRetries) {
          violations.push(`stage "${stage}" attempts ${attempts} exceeds maxRetries ${sla.maxRetries}`)
        }
      }
    }
    if (sla.deliverables) {
      for (const stage of sla.deliverables) {
        if (!result.deliverablesProduced.includes(stage)) {
          violations.push(`missing required deliverable for stage "${stage}"`)
        }
      }
    }

    return violations
  }
}
