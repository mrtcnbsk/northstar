import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import * as ConfigAgent from "../../../src/config/agent"

async function writeAgent(dir: string, name: string, body: string) {
  await mkdir(path.join(dir, "agents"), { recursive: true })
  await Bun.write(path.join(dir, "agents", `${name}.md`), body)
}

describe("subordinates frontmatter expansion", () => {
  test("expands into ordered task permission (deny-all first, allows after)", async () => {
    await using tmp = await tmpdir()
    await writeAgent(
      tmp.path,
      "frontend-chief",
      [
        "---",
        "description: chief",
        "mode: subagent",
        "subordinates: [swiftui-dev-1, apple-docs]",
        "---",
        "You manage the frontend team.",
      ].join("\n"),
    )
    const result = await ConfigAgent.load(tmp.path)
    const chief = result["frontend-chief"]
    expect(chief).toBeDefined()
    const task = chief.permission?.task as Record<string, string>
    expect(task).toBeDefined()
    const entries = Object.entries(task)
    expect(entries[0]).toEqual(["*", "deny"])
    expect(task["swiftui-dev-1"]).toBe("allow")
    expect(task["apple-docs"]).toBe("allow")
  })

  test("explicit permission.task wins over subordinates expansion", async () => {
    await using tmp = await tmpdir()
    await writeAgent(
      tmp.path,
      "custom-chief",
      [
        "---",
        "description: chief",
        "mode: subagent",
        "subordinates: [worker-a]",
        "permission:",
        "  task:",
        '    "*": deny',
        "---",
        "Prompt.",
      ].join("\n"),
    )
    const result = await ConfigAgent.load(tmp.path)
    const task = result["custom-chief"].permission?.task as Record<string, string>
    expect(task["worker-a"]).toBeUndefined()
  })

  test("agents without subordinates get no task rules from expansion", async () => {
    await using tmp = await tmpdir()
    await writeAgent(tmp.path, "worker", "---\ndescription: worker\nmode: subagent\n---\nPrompt.")
    const result = await ConfigAgent.load(tmp.path)
    expect(result["worker"].permission?.task).toBeUndefined()
  })

  test("subordinates does not leak into options", async () => {
    await using tmp = await tmpdir()
    await writeAgent(tmp.path, "chief", "---\nmode: subagent\nsubordinates: [w]\n---\nP.")
    const result = await ConfigAgent.load(tmp.path)
    expect((result["chief"].options ?? {})["subordinates"]).toBeUndefined()
  })
})
