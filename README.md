> ## Ilura Technology OÜ
>
> This is an **open-source (MIT)** project by **Ilura Technology OÜ**, extending the open-source
> [Kilo Code](https://github.com/Kilo-Org/kilocode) and [opencode](https://github.com/sst/opencode)
> projects (both MIT-licensed) with an autonomous multi-agent organization that ships apps end-to-end.
> Ilura holds the copyright in its own additions and releases them under the MIT License, the same
> terms as upstream — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
>
> © 2026 Ilura Technology OÜ. The upstream Kilo Code project README is preserved below for attribution
> and context.

---

<p align="center">
  English | <a href="translations/README.zh.md">简体中文</a> | <a href="translations/README.zht.md">繁體中文</a> | <a href="translations/README.ko.md">한국어</a> | <a href="translations/README.de.md">Deutsch</a> | <a href="translations/README.es.md">Español</a> | <a href="translations/README.fr.md">Français</a> | <a href="translations/README.it.md">Italiano</a> | <a href="translations/README.da.md">Dansk</a> | <a href="translations/README.ja.md">日本語</a> | <a href="translations/README.pl.md">Polski</a> | <a href="translations/README.ru.md">Русский</a> | <a href="translations/README.bs.md">Bosanski</a> | <a href="translations/README.ar.md">العربية</a> | <a href="translations/README.no.md">Norsk</a> | <a href="translations/README.br.md">Português (Brasil)</a> | <a href="translations/README.th.md">ไทย</a> | <a href="translations/README.tr.md">Türkçe</a> | <a href="translations/README.uk.md">Українська</a> | <a href="translations/README.bn.md">বাংলা</a> | <a href="translations/README.gr.md">Ελληνικά</a> | <a href="translations/README.vi.md">Tiếng Việt</a>
</p>

<p align="center"><strong>northstar</strong></p>

<p align="center">A terminal-first AI coding agent — plus an autonomous multi-agent organization (CEO → chiefs → workers) that takes an idea to a shipped app.</p>

---

**northstar** is an open-source CLI by Ilura Technology OÜ, built on [Kilo Code](https://github.com/Kilo-Org/kilocode) and [opencode](https://github.com/sst/opencode) (both MIT). It's a coding agent that lives in your terminal — bring your own model keys (500+ models, mid-task switching, provider-rate pricing, no markup) — and it adds an autonomous org layer that runs a whole software team through human-gated pipelines to build and (with your own Apple credentials) ship apps end-to-end.

### Installation

```bash
# npm
npm install -g @ilura/northstar

# curl
curl -fsSL https://raw.githubusercontent.com/mrtcnbsk/northstar/main/install | bash

# pnpm
pnpm add -g @ilura/northstar

# bun
bun add -g @ilura/northstar
```

Then run `northstar` in any project directory to start.

<details>
<summary>Install from GitHub Releases (binaries)</summary>

Download the latest binary from the [Releases page](https://github.com/mrtcnbsk/northstar/releases).

| Platform | Asset |
|---|---|
| Windows (most PCs) | `northstar-windows-x64.zip` |
| macOS (Apple Silicon) | `northstar-darwin-arm64.zip` |
| macOS (Intel) | `northstar-darwin-x64.zip` |
| Linux x64 | `northstar-linux-x64.tar.gz` |
| Linux ARM | `northstar-linux-arm64.tar.gz` |

Notes: `x64-baseline` is a compatibility build for older CPUs without AVX. `musl` is the statically linked build for Alpine or minimal Docker images without glibc. `Source code` archives are for building from source.

</details>

### Agents

northstar ships with specialized agents you switch between depending on the task. You can also build your own custom agents.

- **Code** - The default. Implements and edits code from natural language.
- **Plan** - Designs architecture and writes implementation plans before any code gets written.
- **Ask** - Answers questions about your codebase without touching any files.
- **Debug** - Troubleshoots and traces issues.
- **Review** - Reviews your changes and surfaces issues across performance, security, style, and test coverage.

Learn more about [agents and custom agents](https://kilo.ai/docs/code-with-ai/agents/using-agents).

### What it does

- **Code generation** from natural language, across multiple files.
- **Inline autocomplete** with ghost-text suggestions and tab to accept.
- **Self-checking** so the agent reviews and corrects its own work.
- **Terminal and browser control** to run commands and automate the web.
- **MCP marketplace** to find and wire up MCP servers that extend what the agent can do.
- **500+ models** with mid-task switching, so you can match latency, cost, and reasoning to the job.

### Autonomous Mode (CI/CD)

Run `northstar run` with `--auto` for fully autonomous operation with no prompts, built for CI/CD pipelines:

```bash
northstar run --auto "run tests and fix any failures"
```

`--auto` disables all permission prompts and lets the agent execute any action without confirmation. Only use it in trusted environments.

### Documentation

For configuration and everything else, [head over to the docs](https://kilo.ai/docs).

### Contributing

Contributions are welcome from developers, writers, and everyone in between. Start with the [Contributing Guide](/CONTRIBUTING.md) for environment setup, coding standards, and how to open a pull request.

Please review our [Code of Conduct](/CODE_OF_CONDUCT.md) before getting involved.

### License

MIT. You're free to use, modify, and distribute this code, including commercially, as long as you keep the attribution and license notices. See [License](/LICENSE).

### FAQ

<details>
<summary>Where did northstar come from?</summary>

northstar is a fork of [Kilo Code](https://github.com/Kilo-Org/kilocode) (itself a fork of [opencode](https://github.com/sst/opencode)), extended by Ilura Technology OÜ with an autonomous multi-agent organization layer.

</details>

