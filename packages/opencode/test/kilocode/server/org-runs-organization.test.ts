import { afterEach, describe, expect, test } from "bun:test"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../../src/server/server"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgWorkspace } from "../../../src/kilocode/organization/workspace"
import { OrgRunsView } from "../../../src/kilocode/server/httpapi/handlers/org-runs"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

const ORGANIZATION = OrgSchema.parse({
  ceo: "ceo",
  departments: { work: { chief: "lead", workers: ["worker"] } },
  pipeline: [{ stage: "work" }],
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

async function published(dir: string, name: string) {
  const staged = await OrgWorkspace.stage(dir, name)
  const ctx = await OrgWorkspace.publish(dir, staged.entry.id)
  await OrgWorkspace.run(ctx, () => OrgSchema.writeOrganization(dir, ORGANIZATION))
  return ctx
}

describe("organization-scoped org runs", () => {
  test("lists only runs from the requested organization", async () => {
    await using tmp = await tmpdir()
    const alpha = await published(tmp.path, "Alpha")
    const beta = await published(tmp.path, "Beta")
    await OrgWorkspace.run(alpha, () => OrgState.create(tmp.path, ORGANIZATION, "alpha mission"))
    await OrgWorkspace.run(beta, () => OrgState.create(tmp.path, ORGANIZATION, "beta mission"))

    expect((await OrgRunsView.list(tmp.path, "alpha")).runs.map((run) => run.idea)).toEqual(["alpha mission"])
    expect((await OrgRunsView.list(tmp.path, "beta")).runs.map((run) => run.idea)).toEqual(["beta mission"])
  })

  test("accepts organizationID on the HTTP list route", async () => {
    await using tmp = await tmpdir()
    const alpha = await published(tmp.path, "Alpha")
    const beta = await published(tmp.path, "Beta")
    await OrgWorkspace.run(alpha, () => OrgState.create(tmp.path, ORGANIZATION, "alpha mission"))
    await OrgWorkspace.run(beta, () => OrgState.create(tmp.path, ORGANIZATION, "beta mission"))

    const response = await Server.Default().app.request("/org-runs?organizationID=alpha", {
      headers: { "x-kilo-directory": tmp.path },
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { runs: Array<{ idea: string }> }).runs.map((run) => run.idea)).toEqual([
      "alpha mission",
    ])
  })
})
