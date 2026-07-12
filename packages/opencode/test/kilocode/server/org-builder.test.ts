// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import * as Log from "@opencode-ai/core/util/log"
import { Server } from "../../../src/server/server"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { resetDatabase } from "../../fixture/db"
import { disposeAllInstances, tmpdir } from "../../fixture/fixture"

void Log.init({ print: false })

type SaveOutput = {
  ok: boolean
  issues: string[]
  path?: string
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function req(dir: string, input: string, init?: RequestInit) {
  return Server.Default().app.request(input, {
    ...init,
    headers: {
      "x-kilo-directory": dir,
      ...init?.headers,
    },
  })
}

/** Seeds a project agent via the existing agent-builder HTTP route (same route the Agents editor
 * uses) so crossCheck-sensitive org-builder tests have real `.kilo/agent/*.md` files to check against. */
async function seedAgent(dir: string, body: Record<string, unknown>) {
  const id = body.id as string
  const saved = await req(dir, `/agent-builder/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (saved.status !== 200) {
    throw new Error(`failed to seed agent "${id}": ${saved.status} ${await saved.text()}`)
  }
}

const VALID_ORG = {
  ceo: "ceo",
  departments: {
    eng: { chief: "chief", workers: ["worker"] },
  },
  shared: [],
  pipeline: [{ stage: "eng" }],
  toolpacks: [],
}

describe("org builder routes", () => {
  test("saves a valid organization, writing .kilo/organization.jsonc", async () => {
    await using tmp = await tmpdir()

    await seedAgent(tmp.path, { id: "ceo", scope: "project", mode: "primary", prompt: "# CEO", subordinates: ["chief"] })
    await seedAgent(tmp.path, {
      id: "chief",
      scope: "project",
      mode: "subagent",
      prompt: "# Chief",
      subordinates: ["worker"],
    })
    await seedAgent(tmp.path, { id: "worker", scope: "project", mode: "subagent", prompt: "# Worker" })

    const response = await req(tmp.path, "/org-builder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization: JSON.stringify(VALID_ORG) }),
    })

    expect(response.status).toBe(200)
    const output = (await response.json()) as SaveOutput
    expect(output.ok).toBe(true)
    expect(output.issues).toEqual([])
    expect(output.path).toBe(path.join(tmp.path, ".kilo", "organization.jsonc"))

    // The write actually landed and is itself a valid, loadable organization.jsonc.
    const loaded = await OrgSchema.loadOrganization(tmp.path)
    expect(loaded.ceo).toBe("ceo")
    expect(loaded.departments.eng).toEqual({ chief: "chief", workers: ["worker"] })
    expect(loaded.pipeline).toEqual([{ stage: "eng" }])
  })

  test("fails closed on a structural error (pipeline stage with no matching department): file is not written", async () => {
    await using tmp = await tmpdir()

    const badOrg = {
      ceo: "ceo",
      departments: {
        eng: { chief: "chief", workers: ["worker"] },
      },
      shared: [],
      pipeline: [{ stage: "ghost" }], // no "ghost" department
      toolpacks: [],
    }

    const response = await req(tmp.path, "/org-builder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization: JSON.stringify(badOrg) }),
    })

    expect(response.status).toBe(200)
    const output = (await response.json()) as SaveOutput
    expect(output.ok).toBe(false)
    expect(output.issues.length).toBeGreaterThan(0)
    expect(output.issues.some((issue) => issue.includes("ghost"))).toBe(true)

    expect(await Bun.file(OrgSchema.organizationPath(tmp.path)).exists()).toBe(false)
  })

  test("fails closed on a cross-check error (agents not defined): file is not written", async () => {
    await using tmp = await tmpdir()

    // No agents seeded at all — org is structurally valid but ceo/chief/worker are undefined.
    const response = await req(tmp.path, "/org-builder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization: JSON.stringify(VALID_ORG) }),
    })

    expect(response.status).toBe(200)
    const output = (await response.json()) as SaveOutput
    expect(output.ok).toBe(false)
    expect(output.issues.some((issue) => issue.includes('ceo agent "ceo" is not defined'))).toBe(true)

    expect(await Bun.file(OrgSchema.organizationPath(tmp.path)).exists()).toBe(false)
  })

  test("fails closed on a JSONC syntax error: file is not written", async () => {
    await using tmp = await tmpdir()

    const response = await req(tmp.path, "/org-builder", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization: "{ not valid json" }),
    })

    expect(response.status).toBe(200)
    const output = (await response.json()) as SaveOutput
    expect(output.ok).toBe(false)
    expect(output.issues.length).toBeGreaterThan(0)

    expect(await Bun.file(OrgSchema.organizationPath(tmp.path)).exists()).toBe(false)
  })
})
