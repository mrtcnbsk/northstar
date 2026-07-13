// kilocode_change - organization-bound Chat session metadata
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { KiloSession } from "../../src/kilocode/session"
import { Session } from "../../src/session/session"
import { Bus } from "../../src/bus"
import { Storage } from "../../src/storage/storage"
import { SyncEvent } from "../../src/sync"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { BackgroundJob } from "../../src/background/job"
import { testEffect } from "../lib/effect"
import { InstanceState } from "../../src/effect/instance-state"
import { OrgWorkspace } from "../../src/kilocode/organization/workspace"

describe("KiloSession organization filtering", () => {
  test("filters sessions by organization and keeps unscoped sessions under legacy", () => {
    const sessions = [
      { id: "a", metadata: { northstarOrganizationID: "alpha" } },
      { id: "b", metadata: { northstarOrganizationID: "beta" } },
      { id: "old", metadata: undefined },
    ]
    expect(KiloSession.forOrganization(sessions, "alpha", false).map((item) => item.id)).toEqual(["a"])
    expect(KiloSession.forOrganization(sessions, "legacy", true).map((item) => item.id)).toEqual(["old"])
  })
})

const it = testEffect(
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.instance("child sessions inherit the parent organization", () =>
  Effect.gen(function* () {
    const service = yield* Session.Service
    const parent = yield* service.create({ metadata: { northstarOrganizationID: "alpha" } })
    const child = yield* service.create({ parentID: parent.id })
    expect(child.metadata?.northstarOrganizationID).toBe("alpha")
    yield* service.remove(child.id)
    yield* service.remove(parent.id)
  }),
)

it.instance("new root sessions snapshot the active project organization", () =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const staged = yield* Effect.promise(() => OrgWorkspace.stage(instance.directory, "Alpha"))
    yield* Effect.promise(() => OrgWorkspace.publish(instance.directory, staged.entry.id))
    const service = yield* Session.Service
    const session = yield* service.create({})
    expect(session.metadata?.northstarOrganizationID).toBe("alpha")
    yield* service.remove(session.id)
  }),
)
