// kilocode_change - new file
import path from "path"
import { mkdir, rename, readdir } from "node:fs/promises"
import z from "zod"
import type { OrgSchema } from "./schema"

export namespace OrgState {
  export const StageStatus = z.enum(["pending", "running", "awaiting_approval", "completed", "failed"])
  export type StageStatus = z.output<typeof StageStatus>

  export const Stage = z.object({
    status: StageStatus,
    taskID: z.string().optional(),
    cost: z.number().optional(),
    attempts: z.number().default(0),
    decision: z.enum(["approve", "no-go", "revise"]).optional(),
    decisionNote: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })
  export type Stage = z.output<typeof Stage>

  export const Run = z.object({
    runID: z.string(),
    idea: z.string(),
    createdAt: z.string(),
    status: z.enum(["active", "halted", "completed"]),
    haltReason: z.string().optional(),
    stages: z.record(z.string(), Stage),
  })
  export type Run = z.output<typeof Run>

  export function runsDir(projectDir: string): string {
    return path.join(projectDir, ".kilo", "org", "runs")
  }

  export function runDir(projectDir: string, runID: string): string {
    return path.join(runsDir(projectDir), runID)
  }

  function stateFile(projectDir: string, runID: string): string {
    return path.join(runDir(projectDir, runID), "state.json")
  }

  export function slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "run"
    )
  }

  function stamp(date: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0")
    return (
      `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
      `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
    )
  }

  export async function create(projectDir: string, org: OrgSchema.Organization, idea: string): Promise<Run> {
    const now = new Date()
    const runID = `${stamp(now)}-${slugify(idea)}`
    const run: Run = {
      runID,
      idea,
      createdAt: now.toISOString(),
      status: "active",
      stages: Object.fromEntries(org.pipeline.map((s) => [s.stage, { status: "pending" as const, attempts: 0 }])),
    }
    await write(projectDir, run)
    return run
  }

  export async function read(projectDir: string, runID: string): Promise<Run> {
    const file = stateFile(projectDir, runID)
    const text = await Bun.file(file)
      .text()
      .catch((e: unknown) => {
        if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
          throw new Error(`Unknown org run "${runID}": expected ${file}`)
        }
        throw new Error(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      })
    return Run.parse(JSON.parse(text))
  }

  export async function update(projectDir: string, runID: string, fn: (run: Run) => void): Promise<Run> {
    const run = await read(projectDir, runID)
    fn(run)
    await write(projectDir, run)
    return run
  }

  export async function list(projectDir: string): Promise<string[]> {
    const entries = await readdir(runsDir(projectDir)).catch(() => [] as string[])
    return entries.sort().reverse()
  }

  async function write(projectDir: string, run: Run): Promise<void> {
    const dir = runDir(projectDir, run.runID)
    await mkdir(dir, { recursive: true })
    const target = stateFile(projectDir, run.runID)
    const tmp = `${target}.tmp`
    await Bun.write(tmp, JSON.stringify(run, null, 2))
    await rename(tmp, target)
  }
}
