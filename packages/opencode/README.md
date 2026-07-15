# northstar

A terminal-first AI coding agent — plus an autonomous multi-agent organization (CEO → chiefs → workers) that takes an idea to a shipped app.

northstar is an open-source (MIT) CLI by **Ilura Technology OÜ**, built on [Kilo Code](https://github.com/Kilo-Org/kilocode) and opencode (both MIT; see [`NOTICE`](https://github.com/mrtcnbsk/northstar/blob/main/NOTICE) for upstream provenance). It lives in your terminal — bring your own model keys (500+ models, mid-task switching, provider-rate pricing, no markup) — and adds an autonomous org layer that runs a whole software team through human-gated pipelines to build and ship apps end-to-end.

## Install

```bash
npm install -g @ilura/northstar
```

Or with another package manager:

```bash
pnpm add -g @ilura/northstar
bun add -g @ilura/northstar
```

## Getting Started

Run `northstar` in any project directory to launch the interactive TUI:

```bash
northstar
```

Run a one-off task:

```bash
northstar run "add input validation to the signup form"
```

### Autonomous Mode (CI/CD)

```bash
northstar run --auto "run tests and fix any failures"
```

`--auto` disables all permission prompts and lets the agent execute any action without confirmation. Only use it in trusted environments.

## Features

- **Code generation** from natural language, across multiple files
- **Terminal and browser control** to run commands and automate the web
- **500+ AI models** with mid-task switching, so you can match latency, cost, and reasoning to the job
- **Self-checking** so the agent reviews and corrects its own work
- **MCP servers** to extend what the agent can do
- **Autonomous organization** — an optional multi-agent org layer that runs a software team through human-gated pipelines

## Commands

| Command                    | Description                |
| -------------------------- | -------------------------- |
| `northstar`                | Launch interactive TUI     |
| `northstar run "<task>"`   | Run a one-off task         |
| `northstar auth`           | Manage authentication      |
| `northstar models`         | List available models      |
| `northstar mcp`            | Manage MCP servers         |
| `northstar session list`   | List sessions              |
| `northstar export`         | Export session transcripts |

Run `northstar --help` for the full list.

## Alternative Installation

### curl

```bash
curl -fsSL https://raw.githubusercontent.com/mrtcnbsk/northstar/main/install | bash
```

### GitHub Releases

Download pre-built binaries from the [Releases page](https://github.com/mrtcnbsk/northstar/releases).

## Links

- [GitHub](https://github.com/mrtcnbsk/northstar)
- [Report an issue](https://github.com/mrtcnbsk/northstar/issues)

## License

MIT. northstar extends the open-source Kilo Code and opencode projects; upstream attribution is preserved in [`NOTICE`](https://github.com/mrtcnbsk/northstar/blob/main/NOTICE). © 2026 Ilura Technology OÜ.
