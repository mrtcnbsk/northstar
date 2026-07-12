/** @jsxImportSource @opentui/solid */
// kilocode_change - new file
import { afterEach, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { tmpdir } from "../../fixture/fixture"

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

export const RUN_ID = "20260712-101000-loop-demo"
export const ORG_JSONC = JSON.stringify({
  ceo: "ceo",
  departments: { build: { chief: "build-chief", workers: ["dev"] } },
  pipeline: [{ stage: "build", gate: "human" }],
})

export function pausedDetail() {
  return {
    run: {
      runID: RUN_ID,
      idea: "loop demo",
      createdAt: "2026-07-12T10:00:00.000Z",
      status: "paused",
      auto: true,
      pausedReason: { kind: "final_gate", stage: "build", detail: "approve to ship" },
      stages: {},
    },
    audit: [],
    totalCost: 3,
    stages: [
      {
        stage: "build",
        status: "awaiting_approval",
        cost: 3,
        attempts: 3,
        startedAt: "2026-07-12T10:09:00.000Z",
        completedAt: null,
        decision: null,
        criteria: ["compiles cleanly", "documents the API"],
        iterations: 2,
        verdictHistory: [{ pass: false, reasons: ["the API is undocumented"], ts: Date.now() }],
      },
    ],
    loop: { maxIterations: 4, evaluatorModel: "haiku" },
    budget: {
      run: 50,
      stage: 15,
      escalationThreshold: 10,
      retries: 2,
      spent: 3,
      remaining: 47,
      escalated: false,
    },
  }
}

function stubFetch(state: { detailCalls: number; failAfter: number }): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    if (url.includes("/org-runs/")) {
      state.detailCalls += 1
      if (state.detailCalls > state.failAfter) return new Response("boom", { status: 500 })
      return json(pausedDetail())
    }
    if (url.includes("/file")) return json({ type: "text", content: ORG_JSONC })
    if (url.includes("/org-runs")) return json({ runs: [] })
    return json({})
  }) as typeof fetch
}

export async function mount(root: string, fetchStub: typeof fetch) {
  const { Global } = await import("@opencode-ai/core/global")
  Global.Path.config = path.join(root, "config")
  Global.Path.state = path.join(root, "state")
  await mkdir(Global.Path.config, { recursive: true })
  await mkdir(Global.Path.state, { recursive: true })
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")

  const [
    { RouteProvider },
    { SDKProvider },
    { ProjectProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { DialogProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { createDefaultOpenTuiKeymap },
    { useRenderer },
    { createTuiResolvedConfig },
    { CockpitView },
  ] = await Promise.all([
    import("../../../src/cli/cmd/tui/context/route"),
    import("../../../src/cli/cmd/tui/context/sdk"),
    import("../../../src/cli/cmd/tui/context/project"),
    import("../../../src/cli/cmd/tui/context/kv"),
    import("../../../src/cli/cmd/tui/context/theme"),
    import("../../../src/cli/cmd/tui/context/tui-config"),
    import("../../../src/cli/cmd/tui/ui/toast"),
    import("../../../src/cli/cmd/tui/ui/dialog"),
    import("../../../src/cli/cmd/tui/keymap"),
    import("@opentui/keymap/opentui"),
    import("@opentui/solid"),
    import("../../fixture/tui-runtime"),
    import("../../../src/kilocode/cockpit/view"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolved = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    registerOpencodeKeymap(keymap, renderer, resolved)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={resolved}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <SDKProvider url="http://localhost:9999" fetch={fetchStub}>
                    <ProjectProvider>
                      <RouteProvider initialRoute={{ type: "cockpit", runID: RUN_ID }}>
                        <CockpitView />
                      </RouteProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  return testRender(() => <Harness />, { width: 80, height: 70 })
}

test("Mission Control renders evaluator + loop panels from a paused run", async () => {
  await using tmp = await tmpdir()
  const state = { detailCalls: 0, failAfter: 999 }
  setup = await mount(tmp.path, stubFetch(state))
  await setup.renderOnce()
  await Bun.sleep(80)
  await setup.renderOnce()
  const out = setup.captureCharFrame()
  expect(out).toContain("Mission Control")
  expect(out).toContain("eval: haiku")
})

test("a transient paused-run poll failure keeps the last-good surface", async () => {
  await using tmp = await tmpdir()
  const state = { detailCalls: 0, failAfter: 1 }
  setup = await mount(tmp.path, stubFetch(state))
  await setup.renderOnce()
  await Bun.sleep(80)
  await setup.renderOnce()
  await Bun.sleep(3_100)
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("Mission Control")
  expect(state.detailCalls).toBeGreaterThan(1)
})

function escalationDetail() {
  const detail = pausedDetail()
  detail.run.pausedReason = { kind: "escalation", stage: "build", detail: "over budget" }
  return detail
}

function recordingFetch(detailFactory: () => unknown, posted: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = request?.method ?? init?.method ?? "GET"
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    if (method === "POST") {
      if (url.includes("/pause")) posted.push("pause")
      else if (url.includes("/stop")) posted.push("stop")
      else if (url.includes("/decision")) posted.push("decision")
      else if (url.includes("/note")) posted.push("note")
      else if (url.includes("/plan")) posted.push("plan")
      return json({ ok: true, runID: RUN_ID, status: "paused" })
    }
    if (url.includes("/org-runs/")) return json(detailFactory())
    if (url.includes("/file")) return json({ type: "text", content: ORG_JSONC })
    if (url.includes("/org-runs")) return json({ runs: [] })
    return json({})
  }) as typeof fetch
}

test("[p] pause posts orgRuns.pause through the production keymap", async () => {
  await using tmp = await tmpdir()
  const posted: string[] = []
  setup = await mount(tmp.path, recordingFetch(pausedDetail, posted))
  await setup.renderOnce()
  await Bun.sleep(80)
  setup.mockInput.pressKey("p")
  await Bun.sleep(50)
  expect(posted).toContain("pause")
})

test("[a] approve on a final gate posts orgRuns.decision", async () => {
  await using tmp = await tmpdir()
  const posted: string[] = []
  setup = await mount(tmp.path, recordingFetch(pausedDetail, posted))
  await setup.renderOnce()
  await Bun.sleep(80)
  setup.mockInput.pressKey("a")
  await Bun.sleep(50)
  expect(posted).toContain("decision")
})

test("[n] no-go on an escalation posts orgRuns.decision", async () => {
  await using tmp = await tmpdir()
  const posted: string[] = []
  setup = await mount(tmp.path, recordingFetch(escalationDetail, posted))
  await setup.renderOnce()
  await Bun.sleep(80)
  setup.mockInput.pressKey("n")
  await Bun.sleep(50)
  expect(posted).toContain("decision")
})

test("[s] on an escalation opens steer composer and never hard-stops", async () => {
  await using tmp = await tmpdir()
  const posted: string[] = []
  setup = await mount(tmp.path, recordingFetch(escalationDetail, posted))
  await setup.renderOnce()
  await Bun.sleep(80)
  setup.mockInput.pressKey("s")
  await Bun.sleep(50)
  await setup.renderOnce()
  expect(posted).not.toContain("stop")
  expect(setup.captureCharFrame()).toContain("enter send, esc cancel")
})
