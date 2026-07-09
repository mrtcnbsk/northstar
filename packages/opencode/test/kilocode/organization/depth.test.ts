import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
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
})
