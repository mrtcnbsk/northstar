# northstar Privacy Policy

**Last Updated: July 14th, 2026**

northstar respects your privacy and is committed to transparency about how your data is handled. Below is a plain breakdown of where key pieces of data go — and where they don't.

### Where Your Data Goes

- **Code & Files**: northstar accesses files on your local machine when needed for AI-assisted features. When you send commands, relevant files and context may be transmitted to your chosen AI model provider (e.g., Anthropic, OpenAI, Google, OpenRouter) — or, if you use gateway/free models, to the model gateway — to generate responses. These providers may store or process that data per their own privacy policies.
- **Commands**: Commands execute on your local environment. The relevant code and context may be transmitted to your chosen model provider (as above) when AI features are used.
- **Prompts & AI Requests**: Your prompts and relevant project context are sent to your chosen model provider (or the gateway) to generate responses, subject to their terms.
- **API Keys & Credentials**: Keys and auth tokens are stored locally on your device (under the northstar data directory) and are not sent to us, except to the provider you have chosen.

### Usage Analytics (Telemetry)

northstar collects **anonymous product-usage analytics by default**, sent to PostHog (`us.i.posthog.com`). This helps improve the product. Telemetry captures **usage and diagnostic metadata only** — it does **not** include your code, file contents, or prompt/response text. Captured events include:

- CLI start/exit and session start/end/message events (session IDs, message source, aggregate stats)
- Model-completion metadata (model ID, provider, token/cost counts)
- Feature usage (command names, tool names, agent usage, indexing, MCP connections)
- Errors and diagnostic events

Events are linked to a random machine ID stored locally (`telemetry-id`); after you sign in, they may also be associated with your account/organization ID.

**Opting out:** set `"experimental": { "openTelemetry": false }` in your northstar config to disable telemetry entirely. You can also set the `KILO_MACHINE_ID` environment variable to control the machine identifier.

### Your Choices & Control

- Run models locally to keep prompts and code off third-party servers.
- Disable telemetry via the config option above.
- Avoid gateway/free models if you do not want prompts routed through the gateway.

### Security & Updates

We take reasonable measures to secure your data, but no system is 100% secure. If this policy changes, we will update this document and note the change in the release notes.

### Contact Us

For privacy-related questions, please open an issue on the project's GitHub repository:
[github.com/mrtcnbsk/northstar/issues](https://github.com/mrtcnbsk/northstar/issues).

---

By using northstar, you agree to this Privacy Policy.
