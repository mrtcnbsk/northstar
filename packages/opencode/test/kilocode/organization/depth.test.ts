import { describe, test, expect } from "bun:test"
import { Cause, Effect } from "effect"
import { OrgDepth } from "../../../src/kilocode/organization/depth"

type Node = { parentID?: string }

function getter(tree: Record<string, Node>) {
  return (id: string) =>
    tree[id] ? Effect.succeed(tree[id]) : Effect.fail(new Error(`unknown session ${id}`))
}

describe("OrgDepth", () => {
  const tree: Record<string, Node> = {
    root: {},
    chief: { parentID: "root" },
    worker: { parentID: "chief" },
  }

  test("depthOf returns 0 for a root session", async () => {
    expect(await Effect.runPromise(OrgDepth.depthOf(getter(tree), "root"))).toBe(0)
  })

  test("depthOf returns 1 for a chief session, 2 for a worker session", async () => {
    expect(await Effect.runPromise(OrgDepth.depthOf(getter(tree), "chief"))).toBe(1)
    expect(await Effect.runPromise(OrgDepth.depthOf(getter(tree), "worker"))).toBe(2)
  })

  test("guard allows spawning from root and chief sessions", async () => {
    await Effect.runPromise(OrgDepth.guard(getter(tree), "root"))
    await Effect.runPromise(OrgDepth.guard(getter(tree), "chief"))
  })

  test("guard rejects spawning from a worker session (would exceed depth 2)", async () => {
    const exit = await Effect.runPromiseExit(OrgDepth.guard(getter(tree), "worker"))
    expect(exit._tag).toBe("Failure")
  })

  test("depthOf stops at MAX_WALK even on a corrupt cyclic chain", async () => {
    const cyclic: Record<string, Node> = { a: { parentID: "b" }, b: { parentID: "a" } }
    const depth = await Effect.runPromise(OrgDepth.depthOf(getter(cyclic), "a"))
    expect(depth).toBe(OrgDepth.MAX_WALK)
  })

  // kilocode_change start - guardFrom walks from an already-fetched node instead of re-fetching
  // the starting session by id; task.ts uses this to avoid a redundant sessions.get(ctx.sessionID)
  describe("guardFrom", () => {
    test("allows spawning from a pre-fetched root or chief node", async () => {
      await Effect.runPromise(OrgDepth.guardFrom(getter(tree), tree.root))
      await Effect.runPromise(OrgDepth.guardFrom(getter(tree), tree.chief))
    })

    test("rejects spawning from a pre-fetched worker node (would exceed depth 2)", async () => {
      const exit = await Effect.runPromiseExit(OrgDepth.guardFrom(getter(tree), tree.worker))
      expect(exit._tag).toBe("Failure")
    })

    test("matches guard's result for the same session, without re-fetching by id", async () => {
      // pass a node with no parentID field access needed beyond what's already fetched
      const start = { parentID: tree.worker.parentID }
      const viaGuard = await Effect.runPromiseExit(OrgDepth.guard(getter(tree), "worker"))
      const viaGuardFrom = await Effect.runPromiseExit(OrgDepth.guardFrom(getter(tree), start))
      // both must fail with the SAME squashed error message, not merely the same exit tag
      const message = (exit: typeof viaGuard) => {
        if (exit._tag !== "Failure") return "success"
        const squashed = Cause.squash(exit.cause)
        return squashed instanceof Error ? squashed.message : String(squashed)
      }
      expect(viaGuard._tag).toBe("Failure")
      expect(message(viaGuardFrom)).toBe(message(viaGuard))
      expect(message(viaGuardFrom)).toContain("Delegation depth limit reached")
    })

    test("error message is neutral (no 'Workers cannot spawn' wording) and reports depth/max", async () => {
      const exit = await Effect.runPromiseExit(OrgDepth.guardFrom(getter(tree), tree.worker))
      expect(exit._tag).toBe("Failure")
      const squashed = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
      const message = squashed instanceof Error ? squashed.message : String(squashed)
      expect(message).toContain("Delegation depth limit reached")
      expect(message).toContain("already 2 level(s) deep")
      expect(message).toContain(`max ${OrgDepth.MAX_DELEGATION_DEPTH}`)
      expect(message).not.toContain("Workers cannot spawn")
    })
  })
  // kilocode_change end
})
