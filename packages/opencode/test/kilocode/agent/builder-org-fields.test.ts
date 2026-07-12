// kilocode_change - new file
//
// RED->GREEN for Task 6.2: the agent `.md` writer (`AgentBuilder`) must round-trip
// `subordinates`/`capabilities`/`preferredTypes` — the org delegation seam. `subordinates` is what
// `ConfigAgent`'s `normalize` expands into `permission.task` on load (see
// `src/config/agent.ts:138-147`), which `OrgSchema.crossCheck` (`src/kilocode/organization/schema.ts`)
// reads to validate an org chart against its agent definitions. If the builder drops these fields when
// serializing, an agent authored via the Agents editor can never participate in an org chart.

import { describe, expect, test } from "bun:test"
import path from "path"
import { AgentBuilder } from "@/kilocode/agent/builder"
import * as ConfigAgent from "@/config/agent"
import { tmpdir } from "../../fixture/fixture"

describe("AgentBuilder org fields", () => {
  test("preview round-trip: subordinates/capabilities/preferredTypes land in the markdown frontmatter", async () => {
    await using tmp = await tmpdir()
    const output = await AgentBuilder.preview(
      { directory: tmp.path },
      {
        id: "ceo",
        scope: "project",
        mode: "primary",
        description: "d",
        prompt: "# Role",
        subordinates: ["chief-a", "worker-b"],
        capabilities: ["swift", "review"],
        preferredTypes: ["ios"],
      },
    )

    expect(output.markdown).toContain("subordinates:")
    expect(output.markdown).toContain("chief-a")
    expect(output.markdown).toContain("worker-b")
    expect(output.markdown).toContain("capabilities:")
    expect(output.markdown).toContain("swift")
    expect(output.markdown).toContain("review")
    expect(output.markdown).toContain("preferredTypes:")
    expect(output.markdown).toContain("ios")
  })

  test("loader round-trip: subordinates re-expands into permission.task on load (the org seam)", async () => {
    await using tmp = await tmpdir()
    await AgentBuilder.save(
      { directory: tmp.path },
      {
        id: "ceo",
        scope: "project",
        mode: "primary",
        description: "d",
        prompt: "# Role",
        subordinates: ["chief-a", "worker-b"],
        capabilities: ["swift", "review"],
        preferredTypes: ["ios"],
      },
    )

    const agents = await ConfigAgent.load(path.join(tmp.path, ".kilo"))
    const ceo = agents["ceo"]
    expect(ceo).toBeDefined()
    expect(ceo.subordinates).toEqual(["chief-a", "worker-b"])
    expect(ceo.capabilities).toEqual(["swift", "review"])
    expect(ceo.preferredTypes).toEqual(["ios"])
    expect(ceo.permission?.task).toEqual({
      "*": "deny",
      "chief-a": "allow",
      "worker-b": "allow",
    })
  })

  test("rejects an integer-like agent id (would break permission.task ordering)", async () => {
    await using tmp = await tmpdir()
    await expect(
      AgentBuilder.preview(
        { directory: tmp.path },
        { id: "123", scope: "project", mode: "subagent", description: "d", prompt: "# Role" },
      ),
    ).rejects.toThrow(/integer-like/)
  })

  test("rejects an integer-like subordinate name (silently denied delegation otherwise)", async () => {
    await using tmp = await tmpdir()
    await expect(
      AgentBuilder.preview(
        { directory: tmp.path },
        { id: "boss", scope: "project", mode: "primary", description: "d", prompt: "# Role", subordinates: ["123"] },
      ),
    ).rejects.toThrow(/integer-like/)
  })

  test("rejects a '*' subordinate name (wildcard collision)", async () => {
    await using tmp = await tmpdir()
    await expect(
      AgentBuilder.preview(
        { directory: tmp.path },
        { id: "boss", scope: "project", mode: "primary", description: "d", prompt: "# Role", subordinates: ["*"] },
      ),
    ).rejects.toThrow(/wildcard/)
  })

  test("allows a name that merely ends in a digit (not purely integer-like)", async () => {
    await using tmp = await tmpdir()
    const output = await AgentBuilder.preview(
      { directory: tmp.path },
      { id: "swiftui-dev-1", scope: "project", mode: "subagent", description: "d", prompt: "# Role", subordinates: ["worker-2"] },
    )
    expect(output.id).toBe("swiftui-dev-1")
    expect(output.markdown).toContain("worker-2")
  })

  test("byte-identical regression: omitting the new fields serializes no subordinates/capabilities/preferredTypes keys", async () => {
    await using tmp = await tmpdir()
    const output = await AgentBuilder.preview(
      { directory: tmp.path },
      {
        id: "plain",
        scope: "project",
        mode: "subagent",
        description: "d",
        prompt: "# Role",
      },
    )

    expect(output.markdown).not.toContain("subordinates")
    expect(output.markdown).not.toContain("capabilities")
    expect(output.markdown).not.toContain("preferredTypes")
  })
})
