// kilocode_change - new file
import { Effect } from "effect"

/**
 * Delegation depth guard for the agent-organization hierarchy.
 * Depth is the number of parent hops to the root session:
 *   CEO (root) = 0, chief = 1, worker = 2.
 * Spawning a subagent from depth d creates a session at depth d+1;
 * anything past MAX_DELEGATION_DEPTH is rejected so workers can never
 * spawn their own subagents even if misconfigured with task permissions.
 */
export namespace OrgDepth {
  export const MAX_DELEGATION_DEPTH = 2
  /** Hard cap on parent-chain walks; protects against corrupt/cyclic data. */
  export const MAX_WALK = 8

  type Getter = (id: string) => Effect.Effect<{ parentID?: string | undefined }, unknown>

  export function depthOf(get: Getter, sessionID: string): Effect.Effect<number, unknown> {
    return Effect.gen(function* () {
      let depth = 0
      let current = yield* get(sessionID)
      while (current.parentID && depth < MAX_WALK) {
        depth++
        current = yield* get(current.parentID)
      }
      return depth
    })
  }

  function depthFrom(get: Getter, start: { parentID?: string | undefined }): Effect.Effect<number, unknown> {
    return Effect.gen(function* () {
      let depth = 0
      let current = start
      while (current.parentID && depth < MAX_WALK) {
        depth++
        current = yield* get(current.parentID)
      }
      return depth
    })
  }

  function fail(depth: number): Effect.Effect<never, unknown> {
    return Effect.fail(
      new Error(
        `Delegation depth limit reached: this session is already ${depth} level(s) deep ` +
          `(max ${MAX_DELEGATION_DEPTH}). Deeper delegation is not permitted.`,
      ),
    )
  }

  /**
   * Guard variant that walks from an already-fetched node instead of re-fetching
   * the starting session. `start` is the node whose depth is being checked (i.e.
   * the depth of `start` itself = hops from `start` to root); the spawn check is
   * unchanged: spawning from `start` would create a session at depth+1.
   */
  export function guardFrom(get: Getter, start: { parentID?: string | undefined }): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      const depth = yield* depthFrom(get, start)
      if (depth + 1 > MAX_DELEGATION_DEPTH) {
        return yield* fail(depth)
      }
    })
  }

  export function guard(get: Getter, sessionID: string): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      const start = yield* get(sessionID)
      yield* guardFrom(get, start)
    })
  }
}
