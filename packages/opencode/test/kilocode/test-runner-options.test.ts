import { describe, expect, test } from "bun:test"
import { TestRunnerOptions } from "../../script/kilocode/test-runner-options"

describe("test runner options", () => {
  test("gives the Windows profile isolated-process headroom", () => {
    expect(TestRunnerOptions.defaults({ profile: "windows", cpus: 8 })).toEqual({
      concurrency: 2,
      timeout: 120_000,
      fileTimeout: 600_000,
    })
  })

  test("preserves the fast defaults for other profiles", () => {
    expect(TestRunnerOptions.defaults({ profile: "darwin", cpus: 8 })).toEqual({
      concurrency: 4,
      timeout: 60_000,
      fileTimeout: 300_000,
    })
  })

  test("never requests more workers than available CPUs", () => {
    expect(TestRunnerOptions.defaults({ profile: "windows", cpus: 1 }).concurrency).toBe(1)
    expect(TestRunnerOptions.defaults({ cpus: 0 }).concurrency).toBe(1)
  })
})
