// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { validateExtraArgs } from "../../../src/kilocode/tool/xcode-argv"

describe("validateExtraArgs", () => {
  test("undefined extraArgs is allowed (no extraArgs provided)", () => {
    expect(validateExtraArgs(undefined)).toBeUndefined()
  })

  test("empty extraArgs is allowed", () => {
    expect(validateExtraArgs([])).toBeUndefined()
  })

  test("benign flags like -quiet and KEY=VALUE build settings are allowed", () => {
    expect(validateExtraArgs(["-quiet", "CODE_SIGNING_ALLOWED=NO"])).toBeUndefined()
  })

  test("rejects -derivedDataPath exactly", () => {
    const err = validateExtraArgs(["-derivedDataPath", "/etc"])
    expect(err).toBe("disallowed extraArg: -derivedDataPath")
  })

  test("rejects -resultBundlePath exactly", () => {
    const err = validateExtraArgs(["-resultBundlePath", "/tmp/evil"])
    expect(err).toBe("disallowed extraArg: -resultBundlePath")
  })

  test("rejects -xcconfig exactly", () => {
    const err = validateExtraArgs(["-xcconfig", "/tmp/evil.xcconfig"])
    expect(err).toBe("disallowed extraArg: -xcconfig")
  })

  test("rejects -xcconfig=value single-arg form", () => {
    const err = validateExtraArgs(["-xcconfig=/tmp/evil.xcconfig"])
    expect(err).toBe("disallowed extraArg: -xcconfig=/tmp/evil.xcconfig")
  })

  test("rejects -derivedDataPath=value single-arg form", () => {
    const err = validateExtraArgs(["-derivedDataPath=/etc"])
    expect(err).toBe("disallowed extraArg: -derivedDataPath=/etc")
  })

  test("rejects any argument containing a .. path-traversal segment", () => {
    const err = validateExtraArgs(["-someFlag", "../../etc/passwd"])
    expect(err).toBe("disallowed extraArg: ../../etc/passwd")
  })

  test("rejects any argument that is an absolute path, even without a dangerous flag name", () => {
    const err = validateExtraArgs(["/etc/passwd"])
    expect(err).toBe("disallowed extraArg: /etc/passwd")
  })

  test("reports the FIRST disallowed argument when multiple are present", () => {
    const err = validateExtraArgs(["-quiet", "-derivedDataPath", "/etc", "-xcconfig", "/tmp/x"])
    expect(err).toBe("disallowed extraArg: -derivedDataPath")
  })

  test("does not flag a flag name that merely contains a dangerous substring but isn't an exact/prefix match", () => {
    // e.g. a hypothetical "-xcconfigFoo" is NOT "-xcconfig" or "-xcconfig=...", so it should pass
    // this denylist (it is not one of the known-dangerous flags).
    expect(validateExtraArgs(["-xcconfigFoo", "bar"])).toBeUndefined()
  })

  test("relative paths without traversal are allowed", () => {
    expect(validateExtraArgs(["-only-testing:MyTests/MyTestCase", "Config/Debug.xcconfig"])).toBeUndefined()
  })
})
