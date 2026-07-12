/** @jsxImportSource @opentui/solid */
// kilocode_change - new file
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { testRender, type JSX } from "@opentui/solid"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"
import { MissionStrip, type StripMode } from "../../../src/kilocode/cockpit/mission-strip"
import type { ConversationCard } from "../../../src/kilocode/cockpit/conversation"
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

async function frame(node: () => JSX.Element) {
  setup = await testRender(
    () => (
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">{node()}</ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    ),
    { width: 70, height: 18 },
  )
  await setup.renderOnce()
  await Bun.sleep(25)
  await setup.renderOnce()
  return setup
}

const noop = () => {}

function strip(card: ConversationCard, mode: StripMode = "idle", sent?: string) {
  return <MissionStrip card={card} mode={mode} sent={sent} onSubmitNote={noop} onCancelNote={noop} />
}

describe("MissionStrip", () => {
  test("final gate renders approve/revise/cancel actions", async () => {
    const view = await frame(() => strip({ kind: "final_gate", stage: "ship", detail: "approve to ship" }))
    const out = view.captureCharFrame()
    expect(out).toContain("Final gate: ship")
    expect(out).toContain("[a] approve")
    expect(out).toContain("[r] revise")
    expect(out).toContain("[c] cancel")
    expect(out).toContain("approve to ship")
  })

  test("escalation renders steer/no-go and reasons", async () => {
    const view = await frame(() =>
      strip({ kind: "escalation", stage: "build", reasons: ["over budget"], detail: "escalated" }),
    )
    const out = view.captureCharFrame()
    expect(out).toContain("Escalation: build")
    expect(out).toContain("[s] steer")
    expect(out).toContain("[n] no-go")
    expect(out).toContain("over budget")
  })

  test("plan renders approve/edit actions and criteria", async () => {
    const view = await frame(() => strip({ kind: "plan", stage: "plan", criteria: ["ship a demo"] }))
    const out = view.captureCharFrame()
    expect(out).toContain("Plan: plan")
    expect(out).toContain("[a] approve")
    expect(out).toContain("[e] edit")
    expect(out).toContain("ship a demo")
  })

  test("note composer submits entered text", async () => {
    let submitted: string | undefined
    const view = await frame(() => (
      <MissionStrip
        card={{ kind: "none" }}
        mode="note"
        sent={undefined}
        onSubmitNote={(text) => (submitted = text)}
        onCancelNote={noop}
      />
    ))
    expect(view.captureCharFrame()).toContain("@name to target")
    await view.mockInput.typeText("slow down")
    await Bun.sleep(20)
    await view.renderOnce()
    view.mockInput.pressEnter()
    await Bun.sleep(25)
    expect(submitted).toBe("slow down")
  })

  test("sent mode renders confirmation", async () => {
    const view = await frame(() => strip({ kind: "none" }, "sent", "Note sent to *"))
    expect(view.captureCharFrame()).toContain("Note sent to *")
  })
})
