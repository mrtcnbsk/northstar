// kilocode_change - new file
import { describe, test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"

/**
 * E7-R2: `OrgRunner.decide`'s stage-selection was `org.pipeline.find(... "awaiting_approval")` -
 * the FIRST awaiting stage in pipeline order. Under a parallel DAG (maxConcurrency > 1), a run can
 * have MULTIPLE stages `awaiting_approval` simultaneously, so a decision meant for one gate could
 * silently land on a different, unrelated one. This file proves the fix: an optional trailing
 * `stage` param on `decide` (and `org_decision`) lets a caller target a SPECIFIC awaiting stage,
 * while omitting it preserves the exact pre-existing "first awaiting stage" behavior (back-compat).
 *
 * The DAG shape (plan -> {frontend, backend}) mirrors wave4-exit.test.ts's diamond fixture. Rather
 * than driving the full fan-out through `advance` (irrelevant to `decide`'s own logic, which only
 * reads `run.stages[stage].status`), this file sets the two branches to `awaiting_approval` directly
 * via `OrgState.update` - the shortest path to the state shape `decide` must handle correctly.
 */

const PARALLEL_ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    plan: { chief: "plan-chief", workers: ["architect"] },
    frontend: { chief: "fe-chief", workers: ["ui"] },
    backend: { chief: "be-chief", workers: ["api"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "plan" },
    { stage: "frontend", requires: ["plan"], gate: "human" },
    { stage: "backend", requires: ["plan"], gate: "human" },
  ],
  maxConcurrency: 2,
})

async function runWithTwoAwaitingGates(tmpPath: string) {
  const run = await OrgRunner.start(tmpPath, PARALLEL_ORG, "parallel gates idea")
  await OrgState.update(tmpPath, run.runID, (s) => {
    s.stages["plan"].status = "completed"
    s.stages["frontend"].status = "awaiting_approval"
    s.stages["backend"].status = "awaiting_approval"
  })
  return run
}

describe("OrgRunner.decide - optional stage targeting (E7-R2)", () => {
  test("decide(..., stage) targets that stage specifically, leaving the other awaiting stage untouched", async () => {
    await using tmp = await tmpdir()
    const run = await runWithTwoAwaitingGates(tmp.path)

    const decided = await OrgRunner.decide(tmp.path, PARALLEL_ORG, run.runID, "approve", undefined, "backend")

    expect(decided.stages["backend"].status).toBe("completed")
    expect(decided.stages["backend"].decision).toBe("approve")
    expect(decided.stages["frontend"].status).toBe("awaiting_approval")
    expect(decided.stages["frontend"].decision).toBeUndefined()

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["backend"].status).toBe("completed")
    expect(state.stages["frontend"].status).toBe("awaiting_approval")
  })

  test("decide(...) with no stage keeps EXACT back-compat behavior: resolves the first awaiting stage in pipeline order", async () => {
    await using tmp = await tmpdir()
    const run = await runWithTwoAwaitingGates(tmp.path)

    // Pipeline order is plan, frontend, backend - frontend is the first stage currently
    // awaiting_approval, so an omitted `stage` must resolve to frontend (unchanged behavior).
    const decided = await OrgRunner.decide(tmp.path, PARALLEL_ORG, run.runID, "approve")

    expect(decided.stages["frontend"].status).toBe("completed")
    expect(decided.stages["frontend"].decision).toBe("approve")
    expect(decided.stages["backend"].status).toBe("awaiting_approval")
    expect(decided.stages["backend"].decision).toBeUndefined()
  })

  test("decide(..., stage) throws a clear error when the named stage is not awaiting approval, without touching any other stage", async () => {
    await using tmp = await tmpdir()
    const run = await runWithTwoAwaitingGates(tmp.path)

    // "plan" exists in the pipeline but is already "completed" - not awaiting approval.
    await expect(
      OrgRunner.decide(tmp.path, PARALLEL_ORG, run.runID, "approve", undefined, "plan"),
    ).rejects.toThrow(/not awaiting approval/i)

    // Neither of the two genuinely-awaiting stages was touched by the failed attempt.
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("awaiting_approval")
    expect(state.stages["backend"].status).toBe("awaiting_approval")
    expect(state.stages["plan"].status).toBe("completed")
    expect(state.stages["plan"].decision).toBeUndefined()
  })

  test("decide(..., stage) throws a clear error when the named stage does not exist in the pipeline", async () => {
    await using tmp = await tmpdir()
    const run = await runWithTwoAwaitingGates(tmp.path)

    await expect(
      OrgRunner.decide(tmp.path, PARALLEL_ORG, run.runID, "approve", undefined, "nonexistent-stage"),
    ).rejects.toThrow(/not awaiting approval/i)

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["frontend"].status).toBe("awaiting_approval")
    expect(state.stages["backend"].status).toBe("awaiting_approval")
  })
})
