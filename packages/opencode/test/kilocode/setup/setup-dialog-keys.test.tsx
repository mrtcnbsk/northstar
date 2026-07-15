/** @jsxImportSource @opentui/solid */
// kilocode_change - regression: Setup's single-key bindings (a / return / arrows) must NOT fire while a
// name/description prompt dialog is open, or they hijack text entry and dismiss/switch the screen.
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function wait(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

test("Setup key bindings do not fire while a prompt dialog is open", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  const { Global } = await import("@opencode-ai/core/global")
  Global.Path.config = path.join(root, "config")
  Global.Path.state = path.join(root, "state")
  await mkdir(Global.Path.config, { recursive: true })
  await mkdir(Global.Path.state, { recursive: true })
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogPrompt },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings },
  ] = await Promise.all([
    import("../../../src/cli/cmd/tui/ui/dialog"),
    import("../../../src/cli/cmd/tui/ui/dialog-prompt"),
    import("../../../src/cli/cmd/tui/context/kv"),
    import("../../../src/cli/cmd/tui/context/theme"),
    import("../../../src/cli/cmd/tui/context/tui-config"),
    import("../../../src/cli/cmd/tui/ui/toast"),
    import("../../../src/cli/cmd/tui/keymap"),
  ])

  const fired: string[] = []
  let dialogRef: ReturnType<typeof useDialog> | undefined

  function SetupLike() {
    const dialog = useDialog()
    // Mirror SetupView bindings WITH the fix (enabled only when no dialog is open). Buggy variant (enabled:true) hijacks input.
    useBindings(() => ({
      enabled: dialog.stack.length === 0, // fix: suppressed while a dialog is open
      bindings: [
        { key: "left", desc: "prev", group: "Setup", cmd: () => fired.push("left") },
        { key: "right", desc: "next", group: "Setup", cmd: () => fired.push("right") },
        { key: "a", desc: "add", group: "Setup", cmd: () => fired.push("a") },
        { key: "return", desc: "next", group: "Setup", cmd: () => fired.push("return") },
      ],
    }))
    onMount(() => {
      dialogRef = dialog
      DialogPrompt.show(dialog, "Organization name", { value: "" })
    })
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolved = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolved)
    onCleanup(off)
    return (
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={resolved}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <SetupLike />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  try {
    await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const ta = () => app.renderer.currentFocusedEditor as TextareaRenderable | undefined
    // Type a name that contains "a" and press arrows — none of the Setup bindings should fire, the
    // dialog should stay open, and the characters should land in the textarea.
    app.mockInput.pressKey("a")
    app.mockInput.pressKey("l")
    app.mockInput.pressKey("p")
    app.mockInput.pressKey("h")
    app.mockInput.pressKey("a")
    await Bun.sleep(40)
    expect(dialogRef?.stack.length ?? 0).toBeGreaterThan(0) // dialog still open
    expect(ta()?.plainText).toBe("alpha")
    expect(fired).toEqual([]) // no Setup binding hijacked the keystrokes
  } finally {
    app.renderer.destroy()
  }
})
