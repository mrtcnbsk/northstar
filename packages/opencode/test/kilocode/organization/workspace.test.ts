import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"
import { Effect } from "effect"

describe("OrgWorkspace", () => {
  test("discovers the unmoved legacy organization", async () => {
    await using tmp = await tmpdir()
    const organization = path.join(tmp.path, ".kilo", "organization.jsonc")
    await Bun.write(
      organization,
      '{"ceo":"ceo","departments":{"work":{"chief":"lead","workers":["worker"]}},"pipeline":[{"stage":"work"}]}',
    )

    const registry = await OrgWorkspace.list(tmp.path)

    expect(registry.active).toBe("legacy")
    expect(registry.organizations).toEqual([{ id: "legacy", name: "Legacy organization", layout: "legacy", root: "." }])
    expect(await Bun.file(organization).exists()).toBe(true)
  })

  test("stages isolated drafts without publishing them", async () => {
    await using tmp = await tmpdir()

    const product = await OrgWorkspace.stage(tmp.path, "Product Studio")
    const research = await OrgWorkspace.stage(tmp.path, "Research Team")

    expect(product.paths.organization).not.toBe(research.paths.organization)
    expect(product.paths.runs).not.toBe(research.paths.runs)
    expect(product.paths.knowledge).not.toBe(research.paths.knowledge)
    expect((await OrgWorkspace.list(tmp.path)).organizations).toEqual([])
    expect((await OrgWorkspace.drafts(tmp.path)).map((item) => item.entry.id).sort()).toEqual([
      "product-studio",
      "research-team",
    ])
  })

  test("publishes and selects a staged organization", async () => {
    await using tmp = await tmpdir()
    const staged = await OrgWorkspace.stage(tmp.path, "Product Studio")
    await Bun.write(staged.paths.organization, "{}")

    const published = await OrgWorkspace.publish(tmp.path, staged.entry.id)

    expect(published.entry.root).toBe("organizations/product-studio")
    expect(published.paths.root).toBe(path.join(tmp.path, ".kilo", "organizations", "product-studio"))
    expect(await Bun.file(published.paths.organization).text()).toBe("{}")
    expect(await Bun.file(staged.paths.root).exists()).toBe(false)
    expect((await OrgWorkspace.active(tmp.path))?.entry.id).toBe("product-studio")
    expect(await OrgWorkspace.drafts(tmp.path)).toEqual([])
  })

  test("selects another published organization", async () => {
    await using tmp = await tmpdir()
    const alpha = await OrgWorkspace.stage(tmp.path, "Alpha")
    await OrgWorkspace.publish(tmp.path, alpha.entry.id)
    const beta = await OrgWorkspace.stage(tmp.path, "Beta")
    await OrgWorkspace.publish(tmp.path, beta.entry.id)

    const selected = await OrgWorkspace.select(tmp.path, alpha.entry.id)

    expect(selected.entry.id).toBe("alpha")
    expect((await OrgWorkspace.active(tmp.path))?.entry.id).toBe("alpha")
  })

  test("discards only staged organizations", async () => {
    await using tmp = await tmpdir()
    const staged = await OrgWorkspace.stage(tmp.path, "Temporary")

    await OrgWorkspace.discard(tmp.path, staged.entry.id)

    expect(await OrgWorkspace.drafts(tmp.path)).toEqual([])
    await expect(OrgWorkspace.discard(tmp.path, staged.entry.id)).rejects.toThrow("Unknown organization draft")
  })

  test("rejects unsafe organization ids and roots", async () => {
    await using tmp = await tmpdir()

    expect(() =>
      OrgWorkspace.paths(tmp.path, { id: "../escape", name: "Unsafe", layout: "managed", root: "x" }),
    ).toThrow("safe organization id")
    expect(() =>
      OrgWorkspace.paths(tmp.path, { id: "safe", name: "Unsafe", layout: "managed", root: "../../escape" }),
    ).toThrow("safe organization root")
  })

  test("keeps organization context across async boundaries", async () => {
    await using tmp = await tmpdir()
    const staged = await OrgWorkspace.stage(tmp.path, "Scoped")

    await OrgWorkspace.run(staged, async () => {
      await Promise.resolve()
      expect(OrgWorkspace.current(tmp.path)?.entry.id).toBe("scoped")
    })
    expect(OrgWorkspace.current(tmp.path)).toBeUndefined()
  })

  test("scopes an Effect runtime without leaking across concurrent organizations", async () => {
    await using tmp = await tmpdir()
    const alpha = await OrgWorkspace.stage(tmp.path, "Alpha")
    const beta = await OrgWorkspace.stage(tmp.path, "Beta")
    const seen = await Promise.all(
      [alpha, beta].map((context, index) =>
        Effect.runPromise(
          OrgWorkspace.effect(
            context,
            Effect.gen(function* () {
              yield* Effect.sleep(`${index + 1} millis`)
              return OrgWorkspace.current(tmp.path)?.entry.id
            }),
          ),
        ),
      ),
    )
    expect(seen).toEqual(["alpha", "beta"])
    expect(OrgWorkspace.current(tmp.path)).toBeUndefined()
  })
})
