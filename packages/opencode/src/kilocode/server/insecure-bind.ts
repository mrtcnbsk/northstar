// kilocode_change - new file: fail closed when the local server would be exposed beyond loopback
// without authentication.
//
// The server authenticates requests only when KILO_SERVER_PASSWORD is set; without it every route —
// including the agent-driving session/prompt, interactive-terminal, background-process, and
// autonomous org-run routes — is reachable with no credential. Binding such a server to a non-loopback
// interface (e.g. `--mdns` flips the host to 0.0.0.0 and advertises it on the LAN) therefore exposes
// remote code execution to the local network. This guard refuses to start in that configuration unless
// the operator explicitly opts in.

export namespace InsecureBind {
  const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1", ""])

  /** True when the resolved hostname binds beyond loopback (0.0.0.0, ::, or a specific interface). */
  export function isExposed(hostname: string): boolean {
    return !LOOPBACK.has(hostname.trim().toLowerCase())
  }

  export type Result = { ok: true } | { ok: false; message: string }

  export function check(input: { hostname: string; hasPassword: boolean; allowUnauthenticated: boolean }): Result {
    if (!isExposed(input.hostname)) return { ok: true }
    if (input.hasPassword) return { ok: true }
    if (input.allowUnauthenticated) return { ok: true }
    return {
      ok: false,
      message:
        `Refusing to start: binding to ${input.hostname} exposes the UNAUTHENTICATED server beyond ` +
        `localhost, giving anyone on the network full agent control (shell, file edits, autonomous runs).\n` +
        `Set KILO_SERVER_PASSWORD to require authentication, or set KILO_ALLOW_UNAUTHENTICATED=1 to bind ` +
        `anyway (unsafe — only in a trusted, isolated network).`,
    }
  }

  /** Whether the env opts into an unauthenticated non-loopback bind. */
  export function allowUnauthenticatedEnv(env = process.env): boolean {
    const v = env.KILO_ALLOW_UNAUTHENTICATED
    return v === "1" || v === "true"
  }
}
