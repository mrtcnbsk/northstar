// kilocode_change - new file
// W0-R2: tests the withRunLock seam in isolation (see its doc comment in tools.ts for the full
// hazard writeup: a stale in-flight org_advance could silently undo org_stop's persisted halt).
// This is a seam test, not a full concurrent-tool-exec test - see the coverage-boundary note in
// the last describe block for why, and what structurally proves the three mutating tools use it.
import { describe, test, expect } from "bun:test"
import path from "path"
import { readFileSync } from "node:fs"
import { withRunLock } from "../../../src/kilocode/organization/tools"

describe("withRunLock", () => {
  test("two racing async mutations on the SAME run_id serialize: no lost update", async () => {
    // A classic lost-update race: both fns read a shared counter, await a tick (so a real
    // interleaving opportunity exists), then write counter+1. Without serialization, both reads
    // observe 0 and both writes land 1 - one increment is lost. With withRunLock, the second fn's
    // read cannot start until the first fn's write has completed.
    let counter = 0
    const bump = () =>
      withRunLock("run-a", async () => {
        const before = counter
        await new Promise((r) => setTimeout(r, 5)) // widen the race window
        counter = before + 1
      })

    await Promise.all([bump(), bump()])
    expect(counter).toBe(2) // both effects landed; neither was lost to interleaving
  })

  test("many racing mutations on the SAME run_id all land in FIFO order", async () => {
    const order: number[] = []
    const tasks = Array.from({ length: 20 }, (_, i) =>
      withRunLock("run-b", async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 3))
        order.push(i)
      }),
    )
    await Promise.all(tasks)
    // FIFO: each link only starts after the previous one's promise settled, and links were
    // chained in call order, so completion order must equal submission order despite the
    // randomized internal delay of each task.
    expect(order).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  test("mutations on DIFFERENT run_ids do not block each other", async () => {
    const events: string[] = []
    const slow = withRunLock("run-c", async () => {
      events.push("c-start")
      await new Promise((r) => setTimeout(r, 30))
      events.push("c-end")
    })
    // Give the slow lock a moment to actually acquire and start before racing run-d.
    await new Promise((r) => setTimeout(r, 5))
    const fast = withRunLock("run-d", async () => {
      events.push("d-start")
      events.push("d-end")
    })
    await Promise.all([slow, fast])
    // run-d's fast, unlocked-by-run-c work finishes and is recorded before run-c's slow work
    // finishes - proving the two run_ids run concurrently rather than being serialized together.
    expect(events.indexOf("d-end")).toBeLessThan(events.indexOf("c-end"))
  })

  test("a rejecting mutation does not wedge the queue for the next caller on the same run_id", async () => {
    const attempt1 = withRunLock("run-e", () => Promise.reject(new Error("boom")))
    await expect(attempt1).rejects.toThrow("boom")

    // If the failure had poisoned the chained tail, this second call would hang or also reject
    // for the wrong reason instead of running.
    const attempt2 = await withRunLock("run-e", async () => "recovered")
    expect(attempt2).toBe("recovered")
  })

  test("the ORIGINAL caller still observes their own rejection (errors are not swallowed)", async () => {
    const results = await Promise.allSettled([
      withRunLock("run-f", async () => {
        await new Promise((r) => setTimeout(r, 5))
        throw new Error("first fails")
      }),
      withRunLock("run-f", async () => "second succeeds"),
    ])
    expect(results[0].status).toBe("rejected")
    if (results[0].status === "rejected") expect(results[0].reason.message).toBe("first fails")
    expect(results[1].status).toBe("fulfilled")
    if (results[1].status === "fulfilled") expect(results[1].value).toBe("second succeeds")
  })

  test("emergency-stop scenario: a stale in-flight mutation cannot undo a later stop once serialized", async () => {
    // Direct repro of the hazard this fix closes: without the lock, a stale org_advance write
    // that started before org_stop but finishes after it would silently overwrite "halted" back
    // to "active". With withRunLock, org_stop's write cannot start until the stale advance's
    // write has fully completed, so it is guaranteed to be the LAST write.
    const state: { status: "active" | "halted" } = { status: "active" }
    const staleAdvance = withRunLock("run-g", async () => {
      const read = state.status // read-before-modify, simulating OrgState.update's read step
      await new Promise((r) => setTimeout(r, 20)) // the "in-flight" window org_stop races into
      state.status = read === "active" ? "active" : state.status // re-affirms whatever it read (no-op write)
    })
    await new Promise((r) => setTimeout(r, 2)) // let staleAdvance acquire the lock first
    const stop = withRunLock("run-g", async () => {
      state.status = "halted"
    })
    await Promise.all([staleAdvance, stop])
    expect(state.status).toBe("halted") // the stop's write landed last; nothing undid it
  })
})

describe("withRunLock coverage boundary", () => {
  // A full concurrent-tool-exec test (spinning up the AI-SDK tool-call machinery and racing real
  // org_advance/org_stop Tool.execute calls against each other) is heavier than this fix
  // warrants: it would require standing up the full ManagedRuntime + Session.Service +
  // InstanceState harness used elsewhere in this directory (see budget-surface.test.ts,
  // stop-tool.test.ts) AND injecting artificial delays into OrgState.update/OrgAudit.append to
  // force a real interleaving window - the seam tests above already prove withRunLock's
  // serialization and error-isolation properties directly and deterministically. What is NOT
  // covered by the seam tests alone is "did tools.ts actually wire the three mutating tools
  // through withRunLock" - a structural/grep-style check for that follows, closing that gap
  // without the cost of a full tool-exec race test. Known coverage boundary: this does not
  // prove the lock is held for the FULL mutating body (vs. e.g. only wrapping a sub-call) -
  // that is verified by code review of tools.ts, not by this test.
  test("org_plan, org_advance, org_decision, and org_stop each call withRunLock; org_start and org_status do not", () => {
    const file = readFileSync(path.join(import.meta.dir, "../../../src/kilocode/organization/tools.ts"), "utf8")

    const toolBody = (toolName: string) => {
      const start = file.indexOf(`Tool.define(\n  "${toolName}"`)
      expect(start).toBeGreaterThan(-1)
      const nextToolDefine = file.indexOf('Tool.define(\n  "', start + 1)
      return file.slice(start, nextToolDefine === -1 ? file.length : nextToolDefine)
    }

    expect(toolBody("org_plan")).toContain("withRunLock(")
    expect(toolBody("org_advance")).toContain("withRunLock(")
    expect(toolBody("org_decision")).toContain("withRunLock(")
    expect(toolBody("org_stop")).toContain("withRunLock(")
    // org_start creates a fresh run (no existing run_id to race against) and org_status is
    // read-only (see the doc comment above withRunLock in tools.ts for the read-consistency
    // rationale for leaving it unlocked) - both are deliberately exempt.
    expect(toolBody("org_start")).not.toContain("withRunLock(")
    expect(toolBody("org_status")).not.toContain("withRunLock(")
  })
})
