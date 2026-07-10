import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

test("arity 1 - unknown commands default to first token", () => {
  expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"])
  expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"])
})

test("arity 2 - two token commands", () => {
  expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"])
})

test("arity 3 - three token commands", () => {
  expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"])
  expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"])
})

test("longest match wins - nested prefixes", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"])
})

test("exact length matches", () => {
  expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
})

test("edge cases", () => {
  expect(BashArity.prefix([])).toEqual([])
  expect(BashArity.prefix(["single"])).toEqual(["single"])
  expect(BashArity.prefix(["git"])).toEqual(["git"])
})

// kilocode_change start - W2.1: Xcode/Swift command arity
test("xcodebuild - arity 2", () => {
  expect(BashArity.prefix(["xcodebuild", "build", "-scheme", "App"])).toEqual(["xcodebuild", "build"])
})

test("swiftlint - arity 2", () => {
  expect(BashArity.prefix(["swiftlint", "lint"])).toEqual(["swiftlint", "lint"])
})

test("swiftformat - arity 2", () => {
  expect(BashArity.prefix(["swiftformat", "file.swift"])).toEqual(["swiftformat", "file.swift"])
})

test("xcrun simctl - arity 3", () => {
  expect(BashArity.prefix(["xcrun", "simctl", "boot", "ID"])).toEqual(["xcrun", "simctl", "boot"])
})
// kilocode_change end
