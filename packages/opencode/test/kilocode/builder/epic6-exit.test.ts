// kilocode_change - new file
//
// EPIC 6 exit test (Task 6.4): assembles a zero org entirely through the Builder's write layer -
// AgentBuilder.save (writes .kilo/agent/*.md, src/kilocode/agent/builder.ts) + OrgSchema.writeOrganization
// (writes .kilo/organization.jsonc, src/kilocode/organization/schema.ts) - then proves it loads +
// validates clean via the SAME load -> validate -> ConfigAgent.load -> crossCheck sequence that
// `org init` (handleInit, src/kilocode/cli/cmd/org.ts) and `org_status`'s no-run_id dry-run path
// (src/kilocode/organization/tools.ts, OrgStatusTool) both use. This is the acceptance case for the
// whole TUI Builder: "build a zero org -> dry-run passes -> files written correctly."

import { describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { AgentBuilder } from "@/kilocode/agent/builder"
import * as ConfigAgent from "@/config/agent"
import { OrgSchema } from "@/kilocode/organization/schema"
import { tmpdir } from "../../fixture/fixture"

describe("EPIC 6 exit: author a zero org via the Builder's write layer", () => {
  test("write agents + org via serializers -> load -> validate -> crossCheck all green", async () => {
    await using tmp = await tmpdir()

    // (a) Write agents via AgentBuilder.save (in-process, no HTTP server involved) - a ceo ->
    // chief -> worker chain wired up through `subordinates`.
    await AgentBuilder.save(
      { directory: tmp.path },
      {
        id: "ceo",
        scope: "project",
        mode: "primary",
        description: "Chief executive agent",
        prompt: "# CEO\nYou run the organization end to end.",
        subordinates: ["chief"],
      },
    )
    await AgentBuilder.save(
      { directory: tmp.path },
      {
        id: "chief",
        scope: "project",
        mode: "subagent",
        description: "Department chief",
        prompt: "# Chief\nYou run the build department.",
        subordinates: ["worker"],
      },
    )
    await AgentBuilder.save(
      { directory: tmp.path },
      {
        id: "worker",
        scope: "project",
        mode: "subagent",
        description: "Worker agent",
        prompt: "# Worker\nYou do the work.",
      },
    )

    for (const id of ["ceo", "chief", "worker"]) {
      expect(await Bun.file(path.join(tmp.path, ".kilo", "agent", `${id}.md`)).exists()).toBe(true)
    }

    // (b) Write the org via OrgSchema.writeOrganization.
    const org: OrgSchema.Organization = {
      ceo: "ceo",
      departments: {
        build: { chief: "chief", workers: ["worker"] },
      },
      shared: [],
      pipeline: [{ stage: "build" }],
      toolpacks: [],
    }
    await OrgSchema.writeOrganization(tmp.path, org)
    expect(await Bun.file(OrgSchema.organizationPath(tmp.path)).exists()).toBe(true)

    // (c) Load + validate: the org the Builder wrote parses and passes structural validation.
    const loaded = await OrgSchema.loadOrganization(tmp.path)
    expect(OrgSchema.validate(loaded)).toEqual([])

    // (d) crossCheck - the delegation seam. Build the view (name -> {mode, subordinates}) exactly
    // as handleInit does (src/kilocode/cli/cmd/org.ts:84-93).
    const agents = await ConfigAgent.load(path.join(tmp.path, ".kilo"))
    const view = Object.fromEntries(
      Object.entries(agents).map(([name, agent]) => [
        name,
        { mode: agent.mode, subordinates: (agent as { subordinates?: readonly string[] }).subordinates },
      ]),
    )
    expect(OrgSchema.crossCheck(loaded, view)).toEqual([])

    // Round-trip proof: AgentBuilder wrote `subordinates` into the frontmatter, ConfigAgent.load's
    // `normalize` (src/config/agent.ts:122-155) re-expanded it into `permission.task` AND preserved
    // `subordinates` itself, which is exactly what crossCheck above just read back out.
    const ceo = agents["ceo"]
    const chief = agents["chief"]
    expect(ceo).toBeDefined()
    expect(chief).toBeDefined()
    expect(ceo.subordinates).toContain("chief")
    expect(chief.subordinates).toContain("worker")
    expect(ceo.permission?.task).toEqual({ "*": "deny", chief: "allow" })

    // (e) dry-run parity: replicate org_status's no-run_id path (src/kilocode/organization/tools.ts
    // ~441-468: load + crossCheck -> {issues}) and assert the Builder-authored org passes it clean.
    const issues = OrgSchema.crossCheck(loaded, view)
    expect(issues).toEqual([])

    // (f) security guard (structural): the Builder writes only non-secret project config - provider
    // credentials go through the 5.2 global-auth wizard and are never written here. Assert none of
    // the files the Builder wrote contain an api-key/secret-shaped field.
    const forbidden = [/"key"\s*:/i, /api[_-]?key/i, /"secret"\s*:/i, /-----BEGIN/i]
    const written = [
      ...(await Promise.all(
        ["ceo", "chief", "worker"].map((id) => fs.readFile(path.join(tmp.path, ".kilo", "agent", `${id}.md`), "utf8")),
      )),
      await fs.readFile(OrgSchema.organizationPath(tmp.path), "utf8"),
    ]
    for (const contents of written) {
      for (const pattern of forbidden) {
        expect(pattern.test(contents)).toBe(false)
      }
    }
  })
})
