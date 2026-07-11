// kilocode_change - new file
// Shared extraArgs validation for xcode_build/xcode_test. Both tools accept a granted worker's
// `extraArgs: string[]`, appended verbatim to the xcodebuild invocation (see buildArgs/buildTestArgs).
// A worker that only has the xcode_build/xcode_test permission (not raw bash) could otherwise use
// extraArgs to escape the project's blast radius entirely — e.g. `-derivedDataPath /etc` or
// `-resultBundlePath ../../../etc/whatever` write outside the project, and `-xcconfig` can inject
// arbitrary build settings (including running scripts) from a file the worker points anywhere on
// disk. This is intentionally a small denylist, not a full argv grammar: it blocks the known
// path-escaping flags and any argument that is itself an absolute path or contains a `..` traversal
// segment, which covers both "pass a dangerous flag" and "pass a dangerous path as some other flag's
// value" without needing to model every xcodebuild flag.
import path from "node:path"

// Flag names that redirect xcodebuild's file I/O outside the project directory it was invoked in,
// or that let the caller inject arbitrary build settings from a file (xcconfig can run scripts via
// build phases / set arbitrary env). Matched both as an exact arg and as an `-xcconfig=value` style
// prefix, since xcodebuild accepts flags either as two args or as one `-flag=value` arg.
const DANGEROUS_FLAGS = ["-derivedDataPath", "-resultBundlePath", "-xcconfig"]

/**
 * Validate a tool-provided `extraArgs` array before it is appended to an xcodebuild invocation.
 * Returns an error message describing the first disallowed argument found, or `undefined` if every
 * argument is acceptable.
 *
 * Rejects:
 * - Any of DANGEROUS_FLAGS, exactly or as an `-xcconfig=...` style prefix.
 * - Any argument containing a `..` path-traversal segment.
 * - Any argument that is itself an absolute path (starts with `/`) — extraArgs are meant to be
 *   flags/values relative to the project, and an absolute path is the shape a path-escaping value
 *   takes even when not attached to one of the named flags above (e.g. a positional path argument).
 */
export function validateExtraArgs(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined
  for (const arg of args) {
    for (const flag of DANGEROUS_FLAGS) {
      if (arg === flag || arg.startsWith(`${flag}=`)) {
        return `disallowed extraArg: ${arg}`
      }
    }
    if (arg.includes("..")) {
      return `disallowed extraArg: ${arg}`
    }
    if (arg.startsWith("/")) {
      return `disallowed extraArg: ${arg}`
    }
  }
  return undefined
}

// kilocode_change start - W7.1: typed path params (xcode_archive/ipa_export) validated
// within-project. Distinct from validateExtraArgs above: an intrinsic path PARAM (e.g.
// `archivePath`, `exportPath`, `exportOptionsPlist`) is expected to legitimately be either a
// project-relative path OR an absolute path that still resolves inside the project's cwd (Xcode
// tooling routinely hands back/expects absolute archive & export paths) — unlike a raw extraArgs
// string, where ANY absolute path is suspicious because it's the caller smuggling a path-shaped
// value into a flag we don't otherwise recognize. What both validators still agree on: a `..`
// traversal segment is never acceptable, and the resolved path may never escape cwd.
/**
 * Validate a tool-provided path parameter (NOT extraArgs — see validateExtraArgs for that)
 * against the project directory it was invoked in. Returns an error message describing the
 * violation, or `undefined` if the path is acceptable.
 *
 * Accepts:
 * - A relative path with no `..` segment (resolved against `cwd`).
 * - An absolute path that resolves inside `cwd`.
 *
 * Rejects:
 * - Any path containing a `..` path-traversal segment.
 * - An absolute path that resolves outside `cwd`.
 */
export function validatePath(value: string, cwd: string): string | undefined {
  if (!value) return "path must not be empty"
  if (value.split(/[\\/]/).includes("..")) {
    return `disallowed path (traversal): ${value}`
  }
  const resolved = path.resolve(cwd, value)
  const relative = path.relative(cwd, resolved)
  // path.relative starting with ".." (or being a distinct absolute path on Windows drive
  // boundaries) means `resolved` fell outside `cwd`.
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return `disallowed path (outside project): ${value}`
  }
  return undefined
}
// kilocode_change end
