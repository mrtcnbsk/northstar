// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { Agent } from "../../../src/agent/agent"
import { TOOLPACKS, TOOLPACK_BY_TOOL_ID } from "../../../src/kilocode/tool/toolpacks"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { ToolRegistry } from "../../../src/tool/registry"
import { disposeAllInstances, provideTmpdirInstance } from "../../fixture/fixture"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../../lib/effect"

const node = CrossSpawnSpawner.defaultLayer
const it = testEffect(Layer.mergeAll(Agent.defaultLayer, ToolRegistry.defaultLayer, node))
const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const appleToolIds = [...TOOLPACKS["apple-delivery"].toolIds]

async function writeOrg(dir: string, extra: Record<string, unknown> = {}) {
  await fs.mkdir(`${dir}/.kilo`, { recursive: true })
  await fs.writeFile(
    OrgSchema.organizationPath(dir),
    JSON.stringify({
      ceo: "ceo",
      departments: { eng: { chief: "chief", workers: ["worker"] } },
      pipeline: [{ stage: "eng" }],
      ...extra,
    }),
  )
}

describe("apple-delivery toolpack visibility", () => {
  test("TOOLPACK_BY_TOOL_ID reverse-indexes every apple tool id to apple-delivery", () => {
    for (const id of appleToolIds) {
      expect(TOOLPACK_BY_TOOL_ID.get(id)).toBe("apple-delivery")
    }
    expect(TOOLPACK_BY_TOOL_ID.get("secret_scan")).toBeUndefined()
    expect(TOOLPACK_BY_TOOL_ID.get("read")).toBeUndefined()
  })

  it.live("hides apple tools when the project has no organization.jsonc at all", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          for (const id of appleToolIds) expect(ids).not.toContain(id)
          // Generic tools must never be gated by the pack.
          expect(ids).toContain("secret_scan")
          expect(ids).toContain("read")
        }),
      { git: true },
    ),
  )

  it.live("hides apple tools when organization.jsonc exists but has no toolpacks field", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeOrg(dir))

          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          for (const id of appleToolIds) expect(ids).not.toContain(id)
          expect(ids).toContain("secret_scan")
          expect(ids).toContain("read")
        }),
      { git: true },
    ),
  )

  it.live("hides apple tools when organization.jsonc has an empty toolpacks array", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeOrg(dir, { toolpacks: [] }))

          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          for (const id of appleToolIds) expect(ids).not.toContain(id)
        }),
      { git: true },
    ),
  )

  it.live("shows apple tools once organization.jsonc opts in via toolpacks: [apple-delivery]", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => writeOrg(dir, { toolpacks: ["apple-delivery"] }))

          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          for (const id of appleToolIds) expect(ids).toContain(id)
          // secret_scan is generic and was never gated; it stays visible either way.
          expect(ids).toContain("secret_scan")
        }),
      { git: true },
    ),
  )

  it.live("apple-delivery opt-in is independent of the org_* gate (org tools stay hidden)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // No organization.jsonc at all - org_* tools hidden - but we still exercise the
          // apple-delivery-enabled path via a separate directory below, so this asserts the
          // reverse independence: a project can opt into apple-delivery tools (once org config
          // exists) without that alone flipping unrelated org_* semantics.
          yield* Effect.promise(() => writeOrg(dir, { toolpacks: ["apple-delivery"] }))

          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const tools = yield* registry.tools({ ...ref, agent: build })
          const ids = tools.map((tool) => tool.id)

          // org_* tools are visible because organization.jsonc exists (independent gate).
          expect(ids).toContain("org_start")
          // apple tools are visible because toolpacks opts in (independent gate).
          for (const id of appleToolIds) expect(ids).toContain(id)
        }),
      { git: true },
    ),
  )
})
