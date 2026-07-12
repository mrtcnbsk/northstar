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

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Mission Strip render")
    await Bun.sleep(20)
  }
}

async function frame(node: () => JSX.Element, text: string) {
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
  await until(async () => {
    await setup?.renderOnce()
    return setup?.captureCharFrame().includes(text) ?? false
  })
  return setup
}

const noop = () => {}

function strip(card: ConversationCard, mode: StripMode = "idle", sent?: string) {
  return <MissionStrip card={card} mode={mode} sent={sent} onSubmitNote={noop} onCancelNote={noop} />
}

describe("MissionStrip", () => {
  test("final gate renders approve/revise/cancel actions", async () => {
    const view = await frame(() => strip({ kind: "final_gate", stage: "ship", detail: "approve to ship" }), "Final gate: ship")
    const out = view.captureCharFrame()
    expect(out).toContain("Final gate: ship")
    expect(out).toContain("[a] approve")
    expect(out).toContain("[r] revise")
    expect(out).toContain("[c] cancel")
    expect(out).toContain("approve to ship")
  })

  test("escalation renders steer/no-go and reasons", async () => {
    const view = await frame(
      () => strip({ kind: "escalation", stage: "build", reasons: ["over budget"], detail: "escalated" }),
      "Escalation: build",
    )
    const out = view.captureCharFrame()
    expect(out).toContain("Escalation: build")
    expect(out).toContain("[s] steer")
    expect(out).toContain("[n] no-go")
    expect(out).toContain("over budget")
  })

  test("plan renders approve/edit actions and criteria", async () => {
    const view = await frame(() => strip({ kind: "plan", stage: "plan", criteria: ["ship a demo"] }), "Plan: plan")
    const out = view.captureCharFrame()
    expect(out).toContain("Plan: plan")
    expect(out).toContain("[a] approve")
    expect(out).toContain("[e] edit")
    expect(out).toContain("ship a demo")
  })

  test("note composer submits entered text", async () => {
    let submitted: string | undefined
    const view = await frame(
      () => (
        <MissionStrip
          card={{ kind: "none" }}
          mode="note"
          sent={undefined}
          onSubmitNote={(text) => (submitted = text)}
          onCancelNote={noop}
        />
      ),
      "@name to target",
    )
    expect(view.captureCharFrame()).toContain("@name to target")
    await view.mockInput.typeText("slow down")
    await until(async () => {
      await view.renderOnce()
      return view.captureCharFrame().includes("slow down")
    })
    view.mockInput.pressEnter()
    await until(() => submitted === "slow down")
    expect(submitted).toBe("slow down")
  })

  test("sent mode renders confirmation", async () => {
    const view = await frame(() => strip({ kind: "none" }, "sent", "Note sent to *"), "Note sent to *")
    expect(view.captureCharFrame()).toContain("Note sent to *")
  })
})
