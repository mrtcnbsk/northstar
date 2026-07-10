// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { buildArgs, MAX_DIAGNOSTICS, parseXcodebuildOutput } from "../../../src/kilocode/tool/xcode-build"

const FAILED_BUILD_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild build -workspace Keel.xcworkspace -scheme Keel -configuration Debug

User defaults from command line:
    IDEPackageSupportUseBuiltinSCM = YES

ComputePackagePrebuildTargetDependencyGraph
ComputePackagePrebuildTargetDependencyGraph (0.1 seconds)

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:42:15: error: cannot find 'HashChain' in scope
    let chain = HashChain(seed: seed)
                ^~~~~~~~~
/Users/dev/keel/Sources/Keel/LedgerStore.swift:58:9: error: value of type 'Ledger' has no member 'appendEntry'
        ledger.appendEntry(entry)
        ^~~~~~
/Users/dev/keel/Sources/Keel/Views/DashboardView.swift:120:31: error: cannot convert value of type 'String' to expected argument type 'Decimal'
    Text(formatAmount(total))
                       ^~~~~

** BUILD FAILED **

The following build commands failed:
	CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
(3 failures)
`

const SUCCEEDED_BUILD_FIXTURE = `
Command line invocation:
    /usr/bin/xcodebuild build -workspace Keel.xcworkspace -scheme Keel -configuration Debug

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/LedgerStore.swift
/Users/dev/keel/Sources/Keel/LedgerStore.swift:12:5: warning: variable 'unused' was never used; consider replacing with '_'
    var unused = 0
        ^

CompileSwift normal arm64 /Users/dev/keel/Sources/Keel/Views/DashboardView.swift
Ld /Users/dev/keel/build/Debug/Keel.app/Contents/MacOS/Keel normal

** BUILD SUCCEEDED **

`

describe("parseXcodebuildOutput", () => {
  test("failed build: ok is false, errors are extracted with file/line/message, buildSucceeded is false", () => {
    const result = parseXcodebuildOutput(FAILED_BUILD_FIXTURE, 65)

    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toHaveLength(3)
    expect(result.warnings).toHaveLength(0)

    expect(result.errors[0]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
      line: 42,
      column: 15,
      severity: "error",
      message: "cannot find 'HashChain' in scope",
    })
    expect(result.errors[1]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
      line: 58,
      column: 9,
      severity: "error",
      message: "value of type 'Ledger' has no member 'appendEntry'",
    })
    expect(result.errors[2]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/Views/DashboardView.swift",
      line: 120,
      column: 31,
      severity: "error",
      message: "cannot convert value of type 'String' to expected argument type 'Decimal'",
    })
  })

  test("succeeded build: ok is true, warnings are parsed, errors empty", () => {
    const result = parseXcodebuildOutput(SUCCEEDED_BUILD_FIXTURE, 0)

    expect(result.ok).toBe(true)
    expect(result.buildSucceeded).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toEqual({
      file: "/Users/dev/keel/Sources/Keel/LedgerStore.swift",
      line: 12,
      column: 5,
      severity: "warning",
      message: "variable 'unused' was never used; consider replacing with '_'",
    })
  })

  test("nonzero exit code wins over a BUILD SUCCEEDED marker in the text", () => {
    const result = parseXcodebuildOutput(SUCCEEDED_BUILD_FIXTURE, 1)

    expect(result.buildSucceeded).toBe(true)
    expect(result.ok).toBe(false)
  })

  test("empty output does not crash and reports failure", () => {
    const result = parseXcodebuildOutput("", 1)

    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("garbage output does not crash and reports failure", () => {
    const garbage = "\x00\x01 not xcodebuild output at all \n\n\t\t random binary noise €€€ 日本語"
    const result = parseXcodebuildOutput(garbage, 1)

    expect(result.ok).toBe(false)
    expect(result.buildSucceeded).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  test("caps errors at MAX_DIAGNOSTICS and reports truncation", () => {
    const lines: string[] = []
    const total = MAX_DIAGNOSTICS + 25
    for (let i = 0; i < total; i++) {
      lines.push(`/Users/dev/keel/Sources/Keel/File${i}.swift:${i + 1}:1: error: synthetic error ${i}`)
    }
    lines.push("** BUILD FAILED **")
    const output = lines.join("\n")

    const result = parseXcodebuildOutput(output, 65)

    expect(result.errors).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.errorTruncated).toBe(true)
    expect(result.warningTruncated).toBe(false)
    // Confirms the cap kept the FIRST MAX_DIAGNOSTICS entries, not an arbitrary subset.
    expect(result.errors[0].message).toBe("synthetic error 0")
    expect(result.errors[MAX_DIAGNOSTICS - 1].message).toBe(`synthetic error ${MAX_DIAGNOSTICS - 1}`)
  })

  test("caps warnings at MAX_DIAGNOSTICS independently from errors", () => {
    const lines: string[] = []
    const total = MAX_DIAGNOSTICS + 10
    for (let i = 0; i < total; i++) {
      lines.push(`/Users/dev/keel/Sources/Keel/File${i}.swift:${i + 1}:1: warning: synthetic warning ${i}`)
    }
    lines.push("** BUILD SUCCEEDED **")
    const output = lines.join("\n")

    const result = parseXcodebuildOutput(output, 0)

    expect(result.warnings).toHaveLength(MAX_DIAGNOSTICS)
    expect(result.warningTruncated).toBe(true)
    expect(result.errorTruncated).toBe(false)
    expect(result.ok).toBe(true)
  })

  test("does not crash on a line matching the diagnostic shape but with an unrecognized severity word", () => {
    const output = "/Users/dev/keel/Sources/Keel/File.swift:1:1: note: this is just a note\n** BUILD SUCCEEDED **"
    const result = parseXcodebuildOutput(output, 0)

    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
  })
})

describe("buildArgs", () => {
  test("includes only the flags that were provided, plus configuration default", () => {
    const args = buildArgs({})
    expect(args).toEqual(["build", "-configuration", "Debug"])
  })

  test("includes workspace, scheme, configuration, destination in order", () => {
    const args = buildArgs({
      workspace: "Keel.xcworkspace",
      scheme: "Keel",
      configuration: "Release",
      destination: "platform=iOS Simulator,name=iPhone 15",
    })
    expect(args).toEqual([
      "build",
      "-workspace",
      "Keel.xcworkspace",
      "-scheme",
      "Keel",
      "-configuration",
      "Release",
      "-destination",
      "platform=iOS Simulator,name=iPhone 15",
    ])
  })

  test("includes project instead of workspace when project is given", () => {
    const args = buildArgs({ project: "Keel.xcodeproj", scheme: "Keel" })
    expect(args).toEqual(["build", "-project", "Keel.xcodeproj", "-scheme", "Keel", "-configuration", "Debug"])
  })

  test("appends extraArgs verbatim at the end", () => {
    const args = buildArgs({ scheme: "Keel", extraArgs: ["-quiet", "CODE_SIGNING_ALLOWED=NO"] })
    expect(args).toEqual([
      "build",
      "-scheme",
      "Keel",
      "-configuration",
      "Debug",
      "-quiet",
      "CODE_SIGNING_ALLOWED=NO",
    ])
  })

  test("defaults configuration to Debug when omitted", () => {
    const args = buildArgs({ scheme: "Keel" })
    expect(args).toContain("-configuration")
    expect(args[args.indexOf("-configuration") + 1]).toBe("Debug")
  })
})
