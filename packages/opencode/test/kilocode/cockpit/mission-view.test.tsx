/** @jsxImportSource @opentui/solid */
// kilocode_change - new file
import { afterEach, describe, expect, test } from "bun:test"
import { testRender, type JSX } from "@opentui/solid"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { MissionEvaluatorPanel, MissionLoopGauge } from "../../../src/kilocode/cockpit/mission-view"
import type { EvaluatorPanel, LoopGaugeVM } from "../../../src/kilocode/cockpit/cockpit-view"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

async function frame(component: () => JSX.Element) {
  setup = await testRender(
    () => (
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">{component()}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    ),
    { width: 60, height: 16 },
  )
  await setup.renderOnce()
  await Bun.sleep(25)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

const PANEL: EvaluatorPanel = {
  stage: "build",
  criteria: [
    { text: "compiles cleanly", met: true },
    { text: "documents the API", met: false },
  ],
  iteration: 2,
  maxIterations: 4,
  latestRejection: "the API is undocumented",
  passed: false,
}

const GAUGE: LoopGaugeVM = {
  iteration: 2,
  maxIterations: 4,
  elapsed: "5s",
  evaluatorModel: "haiku",
  atLimit: false,
}

describe("MissionEvaluatorPanel", () => {
  test("renders stage, criteria, iteration, and rejection", async () => {
    const out = await frame(() => <MissionEvaluatorPanel panel={PANEL} />)
    expect(out).toContain("build")
    expect(out).toContain("✓ compiles cleanly")
    expect(out).toContain("✗ documents the API")
    expect(out).toContain("2/4")
    expect(out).toContain("the API is undocumented")
  })

  test("empty panel renders a placeholder", async () => {
    const empty: EvaluatorPanel = {
      stage: null,
      criteria: [],
      iteration: 0,
      maxIterations: 4,
      latestRejection: null,
      passed: null,
    }
    expect(await frame(() => <MissionEvaluatorPanel panel={empty} />)).toContain("No active stage")
  })
})

describe("MissionLoopGauge", () => {
  test("renders iteration, elapsed, and evaluator model", async () => {
    const out = await frame(() => <MissionLoopGauge gauge={GAUGE} />)
    expect(out).toContain("iter 2/4")
    expect(out).toContain("5s")
    expect(out).toContain("haiku")
  })
})
