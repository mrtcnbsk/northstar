// packages/opencode/test/kilocode/organization/build-allowlist.test.ts
// kilocode_change - W2.1: seam test proving worker bash allowlists match real Xcode/Swift invocations
import { describe, test, expect } from "bun:test"
import path from "path"
import * as ConfigAgent from "../../../src/config/agent"
import { Permission } from "../../../src/permission"
import { BashArity } from "../../../src/permission/arity"
import type { ConfigPermission } from "../../../src/config/permission"

const TEMPLATE = path.resolve(import.meta.dir, "../../../../..", "org-template")

async function loadAgents() {
  return ConfigAgent.load(TEMPLATE)
}

// Mirrors how src/tool/shell.ts builds the checked pattern for a real invocation:
// the live enforcement pattern is the raw command text (see ShellPermission.collect,
// scan.patterns.add(source(node))), evaluated against the agent's bash ruleset via
// Permission.evaluate. BashArity.prefix feeds the "always allow" suggestion glob
// (scan.always), which we also verify below so the arity table stays honest.
function evaluateBash(agentPermission: ConfigPermission.Info | undefined, command: string) {
  const ruleset = Permission.fromConfig(agentPermission ?? {})
  return Permission.evaluate("bash", command, ruleset).action
}

function alwaysPattern(command: string) {
  const tokens = command.split(/\s+/)
  return BashArity.prefix(tokens).join(" ") + " *"
}

// Workers that can edit source and are expected to run Xcode/Swift build tooling.
const XCODEBUILD_WORKERS = ["swiftui-dev-1", "swiftui-dev-2", "data-layer-dev", "unit-tester", "ui-tester", "debugger"]

// Subset that also allows `swift build` / `swift test` (ui-tester does not).
const SWIFT_WORKERS = ["swiftui-dev-1", "swiftui-dev-2", "data-layer-dev", "unit-tester", "debugger"]

// kilocode_change start - W2.4: SwiftLint/SwiftFormat allowlist workers
// Every edit-capable dev/test/debug worker gets swiftlint (lint-check their own work).
const SWIFTLINT_WORKERS = ["swiftui-dev-1", "swiftui-dev-2", "data-layer-dev", "unit-tester", "ui-tester", "debugger"]

// Only workers that own app/production code get swiftformat (test workers lint but don't reformat).
const SWIFTFORMAT_WORKERS = ["swiftui-dev-1", "swiftui-dev-2", "data-layer-dev", "debugger"]

// Consultants (no bash at all) must stay denied even though they sit in the same departments.
const CONSULTANTS_NO_BASH = ["apple-docs", "swiftui-expert", "swiftdata-expert"]
// kilocode_change end

describe("worker bash allowlists match real Xcode/Swift/xcrun commands", () => {
  test("every edit-capable dev/test/debug worker allows a real xcodebuild invocation", async () => {
    const agents = await loadAgents()
    for (const name of XCODEBUILD_WORKERS) {
      const worker = agents[name]
      expect(worker, `worker ${name} must exist in the template`).toBeTruthy()
      const command = "xcodebuild build -scheme App -configuration Debug"
      expect(evaluateBash(worker.permission, command), `worker ${name} must allow: ${command}`).toBe("allow")
    }
  })

  test("every edit-capable dev/test/debug worker allows xcrun simctl boot", async () => {
    const agents = await loadAgents()
    for (const name of XCODEBUILD_WORKERS) {
      const worker = agents[name]
      const command = "xcrun simctl boot ABC"
      expect(evaluateBash(worker.permission, command), `worker ${name} must allow: ${command}`).toBe("allow")
    }
  })

  test("workers with swift build/test in their allowlist allow real swift invocations", async () => {
    const agents = await loadAgents()
    for (const name of SWIFT_WORKERS) {
      const worker = agents[name]
      expect(evaluateBash(worker.permission, "swift build"), `worker ${name} must allow: swift build`).toBe("allow")
      expect(
        evaluateBash(worker.permission, "swift test --filter Foo"),
        `worker ${name} must allow: swift test --filter Foo`,
      ).toBe("allow")
    }
  })

  test("ui-tester has no swift build/test allow rule (xcodebuild/xcrun only)", async () => {
    const agents = await loadAgents()
    const worker = agents["ui-tester"]
    const bash = worker.permission?.bash
    const bashRules = typeof bash === "object" && bash !== null ? bash : {}
    expect(bashRules["swift build*"]).toBeUndefined()
    expect(bashRules["swift test*"]).toBeUndefined()
  })

  test("every edit-capable dev/test/debug worker denies destructive and network commands", async () => {
    const agents = await loadAgents()
    for (const name of XCODEBUILD_WORKERS) {
      const worker = agents[name]
      expect(evaluateBash(worker.permission, "rm -rf /"), `worker ${name} must deny: rm -rf /`).toBe("deny")
      expect(evaluateBash(worker.permission, "curl http://x"), `worker ${name} must deny: curl http://x`).toBe("deny")
    }
  })

  // kilocode_change start - W2.1: arity-derived "always allow" suggestion must itself be
  // covered by the worker's static allowlist, so accepting the suggestion never grants
  // more than the worker's declared bash rules already permit for these commands.
  test("arity-derived always-allow suggestion for xcodebuild/xcrun simctl is itself allowed by the worker ruleset", async () => {
    const agents = await loadAgents()
    for (const name of XCODEBUILD_WORKERS) {
      const worker = agents[name]
      for (const command of ["xcodebuild build -scheme App -configuration Debug", "xcrun simctl boot ABC"]) {
        const suggestion = alwaysPattern(command)
        expect(
          evaluateBash(worker.permission, suggestion),
          `worker ${name} always-allow suggestion "${suggestion}" for "${command}" must itself be allowed`,
        ).toBe("allow")
      }
    }
  })
  // kilocode_change end

  // kilocode_change start - W2.4: SwiftLint/SwiftFormat allowlist coverage
  test("swiftlint-granted dev/test/debug workers allow a real swiftlint invocation", async () => {
    const agents = await loadAgents()
    for (const name of SWIFTLINT_WORKERS) {
      const worker = agents[name]
      expect(worker, `worker ${name} must exist in the template`).toBeTruthy()
      const command = "swiftlint lint --strict"
      expect(evaluateBash(worker.permission, command), `worker ${name} must allow: ${command}`).toBe("allow")
    }
  })

  test("swiftformat-granted app/debug workers allow a real swiftformat invocation", async () => {
    const agents = await loadAgents()
    for (const name of SWIFTFORMAT_WORKERS) {
      const worker = agents[name]
      const command = "swiftformat Sources/App/ContentView.swift"
      expect(evaluateBash(worker.permission, command), `worker ${name} must allow: ${command}`).toBe("allow")
    }
  })

  test("test-only workers (unit-tester, ui-tester) have no swiftformat allow rule", async () => {
    const agents = await loadAgents()
    for (const name of ["unit-tester", "ui-tester"]) {
      const worker = agents[name]
      const command = "swiftformat Tests/AppTests/FooTests.swift"
      expect(evaluateBash(worker.permission, command), `worker ${name} must deny: ${command}`).toBe("deny")
    }
  })

  test("consultants (no bash tools) still deny swiftlint/swiftformat", async () => {
    const agents = await loadAgents()
    for (const name of CONSULTANTS_NO_BASH) {
      const worker = agents[name]
      expect(worker, `consultant ${name} must exist in the template`).toBeTruthy()
      expect(evaluateBash(worker.permission, "swiftlint lint --strict"), `consultant ${name} must deny swiftlint`).toBe(
        "deny",
      )
      expect(
        evaluateBash(worker.permission, "swiftformat File.swift"),
        `consultant ${name} must deny swiftformat`,
      ).toBe("deny")
    }
  })

  test("swiftlint/swiftformat-granted workers still cannot edit .kilo/org/** deliverables", async () => {
    const { Permission } = await import("../../../src/permission")
    const agents = await loadAgents()
    for (const name of SWIFTLINT_WORKERS) {
      const worker = agents[name]
      const ruleset = Permission.fromConfig(worker.permission ?? {})
      expect(
        Permission.evaluate("edit", ".kilo/org/runs/20260710-120000-idea/deliverables/evaluation.md", ruleset).action,
        `worker ${name} must not be able to edit .kilo/org/**`,
      ).toBe("deny")
    }
  })

  test("a non-allowlisted command is still denied for swiftlint/swiftformat-granted workers", async () => {
    const agents = await loadAgents()
    for (const name of SWIFTLINT_WORKERS) {
      const worker = agents[name]
      expect(evaluateBash(worker.permission, "npm install"), `worker ${name} must deny: npm install`).toBe("deny")
    }
  })

  test("arity-derived always-allow suggestion for swiftlint/swiftformat is itself allowed by the worker ruleset", async () => {
    const agents = await loadAgents()
    for (const name of SWIFTLINT_WORKERS) {
      const worker = agents[name]
      const suggestion = alwaysPattern("swiftlint lint --strict")
      expect(
        evaluateBash(worker.permission, suggestion),
        `worker ${name} always-allow suggestion "${suggestion}" for swiftlint must itself be allowed`,
      ).toBe("allow")
    }
    for (const name of SWIFTFORMAT_WORKERS) {
      const worker = agents[name]
      const suggestion = alwaysPattern("swiftformat Sources/App/ContentView.swift")
      expect(
        evaluateBash(worker.permission, suggestion),
        `worker ${name} always-allow suggestion "${suggestion}" for swiftformat must itself be allowed`,
      ).toBe("allow")
    }
  })
  // kilocode_change end
})
