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
})
