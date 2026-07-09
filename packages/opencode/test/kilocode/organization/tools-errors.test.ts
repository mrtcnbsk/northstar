import { describe, test, expect } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { tmpdir } from "../../fixture/fixture"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { tryOrg } from "../../../src/kilocode/organization/tools"

describe("org tools error channel", () => {
  test("readable loadOrganization error survives into the failure channel", async () => {
    await using tmp = await tmpdir()

    const exit = await Effect.runPromiseExit(tryOrg(() => OrgSchema.loadOrganization(tmp.path)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("No organization found")
    expect((error as Error).message).toContain("organization.jsonc")
  })

  test("non-Error rejection is wrapped in an Error carrying the value as its message", async () => {
    const exit = await Effect.runPromiseExit(tryOrg(() => Promise.reject("boom")))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("boom")
  })
})
