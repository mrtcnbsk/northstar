/** @jsxImportSource @opentui/solid */
// kilocode_change - Mission completion summary
import { afterEach, beforeAll, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { testRender, type JSX } from "@opentui/solid"
import { missionCompletion } from "../../../src/kilocode/cockpit/conversation"
import { MissionCompletionState, MissionEmptyState } from "../../../src/kilocode/cockpit/mission-states"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
beforeAll(async () => {
  await mkdir(Global.Path.state, { recursive: true })
  await Bun.write(`${Global.Path.state}/kv.json`, "{}")
})
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

test("completed Mission exposes deliverables, cost, elapsed time, and return action", () => {
  const complete = missionCompletion({
    run: {
      status: "completed",
      createdAt: "2026-07-13T10:00:00.000Z",
    },
    totalCost: 4.25,
    stages: [
      {
        stage: "research",
        status: "completed",
        completedAt: "2026-07-13T10:01:00.000Z",
        deliverablePath: "/project/.kilo/organizations/alpha/org/runs/run_1/deliverables/research.md",
      },
      {
        stage: "delivery",
        status: "completed",
        completedAt: "2026-07-13T10:02:30.000Z",
        deliverablePath: "/project/.kilo/organizations/alpha/org/runs/run_1/deliverables/delivery.md",
      },
    ],
  })

  expect(complete).toEqual({
    title: "Mission complete",
    totalCost: 4.25,
    elapsed: "2m 30s",
    deliverables: [
      {
        stage: "research",
        path: "/project/.kilo/organizations/alpha/org/runs/run_1/deliverables/research.md",
      },
      {
        stage: "delivery",
        path: "/project/.kilo/organizations/alpha/org/runs/run_1/deliverables/delivery.md",
      },
    ],
    action: "Return to Chat",
  })
})

test("active Missions do not expose a completion summary", () => {
  expect(
    missionCompletion({
      run: { status: "active", createdAt: "2026-07-13T10:00:00.000Z" },
      totalCost: 0,
      stages: [],
    }),
  ).toBeUndefined()
})

async function frame(component: () => JSX.Element, text: string) {
  setup = await testRender(
    () => (
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">{component()}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    ),
    { width: 80, height: 16 },
  )
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(text)) return setup.captureCharFrame()
    await Bun.sleep(20)
  }
  throw new Error(`Timed out waiting for ${text}`)
}

test("completed Mission renders final deliverables and Return to Chat", async () => {
  const output = await frame(
    () => (
      <MissionCompletionState
        value={{
          title: "Mission complete",
          totalCost: 4.25,
          elapsed: "2m 30s",
          deliverables: [{ stage: "delivery", path: "/project/deliverables/delivery.md" }],
          action: "Return to Chat",
        }}
        onReturn={() => undefined}
      />
    ),
    "Mission complete",
  )
  expect(output).toContain("Final deliverables")
  expect(output).toContain("delivery.md")
  expect(output).toContain("Return to Chat")
})

test("empty Mission shows organization capacity and Start a mission", async () => {
  const output = await frame(
    () => <MissionEmptyState organizationName="Product Studio" departments={1} agents={3} onStart={() => undefined} />,
    "Start a mission",
  )
  expect(output).toContain("Product Studio")
  expect(output).toContain("1 departments")
  expect(output).toContain("3 agents")
})
