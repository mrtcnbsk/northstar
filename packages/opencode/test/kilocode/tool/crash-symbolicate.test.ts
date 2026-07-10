// kilocode_change - new file
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Sink from "effect/Sink"
import * as PlatformError from "effect/PlatformError"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MessageID, SessionID } from "@/session/schema"
import {
  CrashSymbolicateTool,
  mergeAtosOutput,
  normalizeArch,
  parseCrashLog,
  renderSymbolicatedTrace,
  resolveCrashLogText,
  resolveDsymBinary,
  MAX_FRAMES,
} from "../../../src/kilocode/tool/crash-symbolicate"
import { testEffect } from "../../lib/effect"

// A realistic iOS crash-reporter log: app image (Keel) + several system images, a crashed thread
// mixing app frames and system frames, and a second uncrashed thread (to prove thread-scoping).
const CRASH_LOG_FIXTURE = `Incident Identifier: 11111111-2222-3333-4444-555555555555
CrashReporter Key:   abcdef0123456789
Hardware Model:      iPhone14,5
Process:              Keel [1234]
Path:                 /private/var/containers/Bundle/Application/XXXX/Keel.app/Keel
Identifier:            com.ilura.keel
Version:               1.0 (1)
Code Type:             ARM-64
Role:                  Foreground
Parent Process:        launchd [1]

Date/Time:             2026-07-09 10:00:00.000 -0700
OS Version:             iPhone OS 17.5 (21F79)
Report Version:        104

Exception Type:  EXC_BAD_ACCESS (SIGSEGV)
Exception Subtype: KERN_INVALID_ADDRESS at 0x0000000000000000
Triggered by Thread:  0

Thread 0 Crashed:
0   Keel                          0x0000000104f2c1a0 0x104f28000 + 16800
1   Keel                          0x0000000104f30bf4 0x104f28000 + 34292
2   UIKitCore                      0x00000001a2b4c9d8 0x1a2000000 + 12345432
3   libdyld.dylib                  0x00000001b3c5c3d8 0x1b3c58000 + 16856

Thread 1:
0   libsystem_kernel.dylib         0x00000001b1234567 0x1b1230000 + 17767

Binary Images:
0x104f28000 - 0x104f5ffff Keel arm64  <a1b2c3d4e5f647a8b9c0d1e2f3a4b5c6> /var/containers/Bundle/Application/XXXX/Keel.app/Keel
0x1a2000000 - 0x1a4ffffff UIKitCore arm64  <11223344556677889900aabbccddeeff> /System/Library/PrivateFrameworks/UIKitCore.framework/UIKitCore
0x1b3c58000 - 0x1b3c8ffff libdyld.dylib arm64  <deadbeefdeadbeefdeadbeefdeadbeef> /usr/lib/system/libdyld.dylib
0x1b1230000 - 0x1b125ffff libsystem_kernel.dylib arm64  <cafebabecafebabecafebabecafebabe> /usr/lib/system/libsystem_kernel.dylib
`

describe("parseCrashLog", () => {
  test("extracts the app's binary image with its load address", () => {
    const result = parseCrashLog(CRASH_LOG_FIXTURE)
    const app = result.images.find((i) => i.name === "Keel")
    expect(app).toBeDefined()
    expect(app!.loadAddress).toBe("0x104f28000")
    expect(app!.uuid).toBe("a1b2c3d4e5f647a8b9c0d1e2f3a4b5c6")
    expect(app!.path).toBe("/var/containers/Bundle/Application/XXXX/Keel.app/Keel")
  })

  test("extracts all binary images, including system frameworks", () => {
    const result = parseCrashLog(CRASH_LOG_FIXTURE)
    const names = result.images.map((i) => i.name)
    expect(names).toEqual(["Keel", "UIKitCore", "libdyld.dylib", "libsystem_kernel.dylib"])
  })

  test("extracts backtrace frames with index/image/address, mixing app + system frames", () => {
    const result = parseCrashLog(CRASH_LOG_FIXTURE)
    // Thread 0 (4 frames) + Thread 1 (1 frame) = 5 total.
    expect(result.frames).toHaveLength(5)
    expect(result.frames[0]).toMatchObject({ index: 0, seq: 0, image: "Keel", address: "0x0000000104f2c1a0" })
    expect(result.frames[1]).toMatchObject({ index: 1, seq: 1, image: "Keel", address: "0x0000000104f30bf4" })
    expect(result.frames[2]).toMatchObject({ index: 2, seq: 2, image: "UIKitCore", address: "0x00000001a2b4c9d8" })
    expect(result.frames[3]).toMatchObject({ index: 3, seq: 3, image: "libdyld.dylib", address: "0x00000001b3c5c3d8" })
    // Thread 1's own frame 0 — the crash log restarts frame numbering per thread, so `index` is 0
    // again here even though this is globally the 5th frame (`seq: 4` disambiguates it).
    expect(result.frames[4]).toMatchObject({
      index: 0,
      seq: 4,
      image: "libsystem_kernel.dylib",
      address: "0x00000001b1234567",
    })
  })

  test("identifies the crashed thread's own image via crashedImage", () => {
    const result = parseCrashLog(CRASH_LOG_FIXTURE)
    expect(result.crashedImage).toBe("Keel")
  })

  test("parses the process name from the Process: header", () => {
    const result = parseCrashLog(CRASH_LOG_FIXTURE)
    expect(result.processName).toBe("Keel")
  })

  test("counts threads and parses Code Type", () => {
    const result = parseCrashLog(CRASH_LOG_FIXTURE)
    expect(result.threadCount).toBe(2)
    expect(result.codeType).toBe("ARM-64")
  })

  test("empty crash log does not crash and returns no images/frames", () => {
    const result = parseCrashLog("")
    expect(result.images).toEqual([])
    expect(result.frames).toEqual([])
  })

  test("garbage crash log does not crash and returns no frames", () => {
    const garbage = "\x00\x01 not a crash log at all \n\n\t\t random binary noise €€€ 日本語"
    const result = parseCrashLog(garbage)
    expect(result.frames).toEqual([])
  })

  test("huge/garbage crash log is bounded, no crash", () => {
    // Deterministic huge input: repeat a large noise block far past MAX_CRASH_LOG_BYTES.
    const noise = "x".repeat(1024 * 1024)
    const result = parseCrashLog(noise)
    expect(result.frames.length).toBeLessThanOrEqual(MAX_FRAMES)
    expect(result.images.length).toBeLessThanOrEqual(MAX_FRAMES)
  })

  test("caps frames at MAX_FRAMES for a pathologically long single-thread backtrace", () => {
    const lines: string[] = ["Thread 0 Crashed:"]
    const total = MAX_FRAMES + 50
    for (let i = 0; i < total; i++) {
      lines.push(`${i}   Keel                          0x0000000104f2c${i} 0x104f28000 + ${i}`)
    }
    const result = parseCrashLog(lines.join("\n"))
    expect(result.frames.length).toBe(MAX_FRAMES)
  })
})

describe("normalizeArch", () => {
  test("maps ARM-64 Code Type to arm64", () => {
    expect(normalizeArch("ARM-64")).toBe("arm64")
  })
  test("defaults to arm64 when undefined", () => {
    expect(normalizeArch(undefined)).toBe("arm64")
  })
  test("maps arm64e variants", () => {
    expect(normalizeArch("arm64e")).toBe("arm64e")
  })
  test("maps X86-64 to x86_64", () => {
    expect(normalizeArch("X86-64")).toBe("x86_64")
  })
})

describe("resolveCrashLogText", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "crash-symbolicate-test-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("treats multi-line input as literal crash text", () => {
    expect(resolveCrashLogText(CRASH_LOG_FIXTURE)).toBe(CRASH_LOG_FIXTURE)
  })

  test("reads file contents when given an existing path", () => {
    const file = path.join(dir, "crash.ips")
    writeFileSync(file, CRASH_LOG_FIXTURE)
    expect(resolveCrashLogText(file)).toBe(CRASH_LOG_FIXTURE)
  })

  test("falls back to literal text when the path-like string does not exist", () => {
    const fake = path.join(dir, "does-not-exist.ips")
    expect(resolveCrashLogText(fake)).toBe(fake)
  })
})

describe("resolveDsymBinary", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "crash-symbolicate-dsym-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("resolves a .dSYM bundle to the binary inside Contents/Resources/DWARF", () => {
    const dsym = path.join(dir, "Keel.app.dSYM")
    const dwarf = path.join(dsym, "Contents", "Resources", "DWARF")
    mkdirSync(dwarf, { recursive: true })
    writeFileSync(path.join(dwarf, "Keel"), "fake-binary")
    expect(resolveDsymBinary(dsym)).toBe(path.join(dwarf, "Keel"))
  })

  test("returns the path directly when given the binary file itself", () => {
    const binary = path.join(dir, "Keel")
    writeFileSync(binary, "fake-binary")
    expect(resolveDsymBinary(binary)).toBe(binary)
  })

  test("returns undefined for a missing path", () => {
    expect(resolveDsymBinary(path.join(dir, "nope.dSYM"))).toBeUndefined()
  })

  test("returns undefined for a directory with no DWARF folder", () => {
    const emptyDir = path.join(dir, "Empty.dSYM")
    mkdirSync(emptyDir, { recursive: true })
    expect(resolveDsymBinary(emptyDir)).toBeUndefined()
  })
})

describe("mergeAtosOutput", () => {
  test("marks frames resolved when atos returns a symbol line", () => {
    const frames = parseCrashLog(CRASH_LOG_FIXTURE).frames.filter((f) => f.image === "Keel")
    const atosOutput = [
      "LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)",
      "main (in Keel) (main.swift:10)",
    ].join("\n")
    const merged = mergeAtosOutput(frames, atosOutput)
    expect(merged).toHaveLength(2)
    expect(merged[0].resolved).toBe(true)
    expect(merged[0].symbol).toBe("LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)")
    expect(merged[1].resolved).toBe(true)
  })

  test("leaves a frame unresolved when atos echoes the raw address back", () => {
    const frames = parseCrashLog(CRASH_LOG_FIXTURE).frames.filter((f) => f.image === "Keel")
    // atos's own behavior when it cannot resolve: echoes the address (optionally with the image).
    const atosOutput = ["0x0000000104f2c1a0", "main (in Keel) (main.swift:10)"].join("\n")
    const merged = mergeAtosOutput(frames, atosOutput)
    expect(merged[0].resolved).toBe(false)
    expect(merged[0].symbol).toBeUndefined()
    expect(merged[1].resolved).toBe(true)
  })

  test("handles missing output lines (fewer lines than frames) without crashing", () => {
    const frames = parseCrashLog(CRASH_LOG_FIXTURE).frames.filter((f) => f.image === "Keel")
    const merged = mergeAtosOutput(frames, "only-one-line (in Keel) (X.swift:1)")
    expect(merged).toHaveLength(2)
    expect(merged[0].resolved).toBe(true)
    expect(merged[1].resolved).toBe(false)
  })
})

describe("renderSymbolicatedTrace", () => {
  test("replaces resolved frames and leaves the rest untouched", () => {
    const parsed = parseCrashLog(CRASH_LOG_FIXTURE)
    const resolved = new Map<number, string>([[0, "LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)"]])
    const text = renderSymbolicatedTrace(parsed, resolved)
    const lines = text.split("\n")
    expect(lines[0]).toContain("LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)")
    // Frame 2 (UIKitCore, a system frame) was never targeted for resolution, so its raw line
    // (containing the original hex address) must be preserved verbatim.
    expect(lines[2]).toContain("0x00000001a2b4c9d8")
  })
})

// ---- Effect-harness tests for the execute path ----

const encoder = new TextEncoder()

const harness = testEffect(
  Layer.mergeAll(AppFileSystem.defaultLayer, Truncate.defaultLayer, Config.defaultLayer, Agent.defaultLayer),
)

function fakeHandle(all: ChildProcessSpawner.ChildProcessHandle["all"], exit = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exit)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "code",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const runExecute = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  params: { crashLog: string; dsymPath: string; arch?: string; loadAddress?: string },
) =>
  Effect.gen(function* () {
    const info = yield* CrashSymbolicateTool
    const tool = yield* info.init()
    return yield* tool.execute(params, baseCtx as any)
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))

describe("CrashSymbolicateTool execute", () => {
  let dsymDir: string
  let dwarfBinary: string

  beforeEach(() => {
    dsymDir = mkdtempSync(path.join(tmpdir(), "crash-symbolicate-exec-"))
    const dwarf = path.join(dsymDir, "Keel.app.dSYM", "Contents", "Resources", "DWARF")
    mkdirSync(dwarf, { recursive: true })
    dwarfBinary = path.join(dwarf, "Keel")
    writeFileSync(dwarfBinary, "fake-binary")
  })
  afterEach(() => {
    rmSync(dsymDir, { recursive: true, force: true })
  })

  harness.instance("full symbolication with a stubbed atos: frames resolved, counts correct, trace contains symbols", () =>
    Effect.gen(function* () {
      const atosOutput = [
        "LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)",
        "main (in Keel) (main.swift:10)",
      ].join("\n")
      const all = Stream.make(encoder.encode(atosOutput))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner, {
        crashLog: CRASH_LOG_FIXTURE,
        dsymPath: path.join(dsymDir, "Keel.app.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.framesTotal).toBe(5)
      expect(summary.framesResolved).toBe(2)
      expect(summary.symbolicated).toContain("LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)")
      expect(summary.symbolicated).toContain("main (in Keel) (main.swift:10)")
      // System frames remain raw (untouched hex addresses).
      expect(summary.symbolicated).toContain("0x00000001a2b4c9d8")
      expect(summary.unresolvedNote).toBeUndefined()
    }),
  )

  harness.instance("missing dsym: ok:false, raw trace returned + note, no crash", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "Command",
            method: "spawn",
            pathOrDescriptor: "atos",
            description: "should not be reached",
          }),
        ),
      )
      const result = yield* runExecute(spawner, {
        crashLog: CRASH_LOG_FIXTURE,
        dsymPath: path.join(dsymDir, "does-not-exist.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.framesResolved).toBe(0)
      expect(typeof summary.note).toBe("string")
      expect(summary.note).toContain("dSYM")
      // Raw trace still returned (all 5 frames present as raw lines).
      expect(summary.symbolicated.split("\n")).toHaveLength(5)
    }),
  )

  harness.instance("atos spawn error (ENOENT): ok:false, raw trace + symbolizer-unavailable note, no crash", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "Command",
            method: "spawn",
            pathOrDescriptor: "atos",
            description: "spawn atos ENOENT",
          }),
        ),
      )
      const result = yield* runExecute(spawner, {
        crashLog: CRASH_LOG_FIXTURE,
        dsymPath: path.join(dsymDir, "Keel.app.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.framesResolved).toBe(0)
      expect(summary.note.toLowerCase()).toContain("symbolizer unavailable")
      expect(summary.note).toContain("atos")
      expect(summary.symbolicated.split("\n")).toHaveLength(5)
    }),
  )

  harness.instance("a frame atos can't resolve is left as-is; framesResolved reflects the partial", () =>
    Effect.gen(function* () {
      // First app frame resolves, second is echoed back unresolved by atos.
      const atosOutput = ["LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)", "0x0000000104f30bf4"].join("\n")
      const all = Stream.make(encoder.encode(atosOutput))
      const spawner = ChildProcessSpawner.make(() => Effect.succeed(fakeHandle(all, 0)))
      const result = yield* runExecute(spawner, {
        crashLog: CRASH_LOG_FIXTURE,
        dsymPath: path.join(dsymDir, "Keel.app.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(true)
      expect(summary.framesTotal).toBe(5)
      expect(summary.framesResolved).toBe(1)
      expect(summary.symbolicated).toContain("LedgerStore.append(_:) (in Keel) (LedgerStore.swift:42)")
      // The unresolved app frame keeps its original raw address in the trace.
      expect(summary.symbolicated).toContain("0x0000000104f30bf4")
      expect(summary.unresolvedNote).toContain("1 of 2")
    }),
  )

  harness.instance("huge/garbage crash log input does not crash the tool", () =>
    Effect.gen(function* () {
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "Command",
            method: "spawn",
            pathOrDescriptor: "atos",
            description: "should not be reached",
          }),
        ),
      )
      const garbage = "x".repeat(5 * 1024 * 1024)
      const result = yield* runExecute(spawner, {
        crashLog: garbage,
        dsymPath: path.join(dsymDir, "Keel.app.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.framesTotal).toBe(0)
      expect(typeof summary.note).toBe("string")
    }),
  )

  harness.instance("crash log with no app-image frames (system-only) degrades gracefully", () =>
    Effect.gen(function* () {
      // The app that actually crashed is "Keel" (per Process:), but Keel never appears in the
      // Binary Images / backtrace here (e.g. a truncated log excerpt) — only a system frame does.
      // A naive "top frame of the crashed thread = the app" heuristic would misidentify
      // libsystem_kernel.dylib as the app and try to symbolicate it against Keel's dSYM; the tool
      // must recognize there is genuinely no app-image frame to resolve.
      const systemOnlyLog = `Process:              Keel [1234]
Code Type:             ARM-64
Thread 0 Crashed:
0   libsystem_kernel.dylib         0x00000001b1234567 0x1b1230000 + 17767

Binary Images:
0x1b1230000 - 0x1b125ffff libsystem_kernel.dylib arm64  <cafebabecafebabecafebabecafebabe> /usr/lib/system/libsystem_kernel.dylib
`
      const spawner = ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "Command",
            method: "spawn",
            pathOrDescriptor: "atos",
            description: "should not be reached",
          }),
        ),
      )
      const result = yield* runExecute(spawner, {
        crashLog: systemOnlyLog,
        dsymPath: path.join(dsymDir, "Keel.app.dSYM"),
      })
      const summary = JSON.parse(result.output)
      expect(summary.ok).toBe(false)
      expect(summary.framesResolved).toBe(0)
      expect(summary.note).toContain("system frames")
    }),
  )
})
