# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

northstar is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

### Permissions and sandbox

The permission system is a **UX feature**, not a security boundary. It prompts for confirmation before executing commands, writing files, etc., to keep you aware of what the agent is doing — it is not designed to provide isolation.

northstar ships an **optional** OS-level sandbox (bubblewrap on Linux, Seatbelt on macOS) that restricts tool execution. It is **off by default** and must be enabled explicitly. When it is unavailable (e.g. bubblewrap not installed, or on Windows), tools run unrestricted.

If you need true isolation, enable the sandbox and/or run northstar inside a Docker container or VM. Note that `--auto` and `--dangerously-skip-permissions` auto-approve every permission ask, including config-file edits — only use them in trusted, isolated environments.

### Server Mode

Server mode is opt-in only. When enabled, set `KILO_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning), so **do not expose it beyond localhost** — in particular, avoid combining `--mdns` (which binds the listener to `0.0.0.0` and advertises it on the LAN) with an unauthenticated server. It is the end user's responsibility to secure the server.

### Out of Scope

| Category | Rationale |
|---|---|
| **Server access when opted-in** | If you enable server mode, API access is expected behavior |
| **Permission-prompt bypasses** | The permission system is a UX feature, not a sandbox (see above) |
| **LLM provider data handling** | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior** | External MCP servers you configure are outside our trust boundary |
| **Malicious config files** | Users control their own config; modifying it is not an attack vector |

---

# Reporting Security Issues

We value the contributions of the security research community and recognize the importance of a coordinated approach to vulnerability disclosure. If you have discovered a security vulnerability, we encourage you to let us know so we can resolve it promptly.

Please report vulnerabilities privately through GitHub Security Advisories:
**[Report a vulnerability](https://github.com/mrtcnbsk/northstar/security/advisories/new)**
(Security → Advisories → "Report a vulnerability" on the repository).

We will acknowledge your report and keep you informed of the progress towards a fix. Please do **not** open a public issue for security vulnerabilities.
