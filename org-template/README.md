# App-Building Agent Organization

A 26-agent organization (CEO -> 8 department chiefs -> workers) that takes an app
idea to an App Store-ready package with two human gates (post-evaluation go/no-go,
pre-release approval).

## Install into an app project

```bash
mkdir -p /path/to/your-app/.kilo
cp -r org-template/. /path/to/your-app/.kilo/
```

## Run

From the project directory, start the CLI and run:

```
/build-app <your app idea in one or two sentences>
```

Resume after an interruption: `/build-app --resume <run-id>`
Inspect without advancing: `/build-app --status` (or with a run id)
Dry-run the org config (validation, no LLM pipeline): ask the CEO to call
`org_status` — it loads and validates `organization.jsonc` and lists runs.

## State and deliverables

Everything lives under `.kilo/org/runs/<run-id>/`:
- `state.json` — pipeline state machine (resumable at any time)
- `deliverables/<stage>.md` — each department's output

## Models

Each agent pins its model in its frontmatter (`model: provider/model-id`).
Defaults: chiefs/CEO `anthropic/claude-fable-5`, dev/test workers
`anthropic/claude-sonnet-5`, mechanical marketing workers
`anthropic/claude-haiku-4-5-20251001`. BYOK: configure your provider keys in
`kilo.jsonc` / via the CLI auth flow; models without a local key route through
the Kilo Gateway. Change any agent's file to change its model — check the model
picker for the exact ids available to your account.

## Editing the organization

- Add/remove workers: edit the department in `organization.jsonc` AND the chief's
  `subordinates` list AND create the worker's markdown file. `org_status` reports
  inconsistencies.
- Permission rule maps are order-sensitive (last match wins): keep `"*": deny`
  as the FIRST entry and specific allows after it.
- `webfetch`/`websearch` permissions are on/off switches (no URL patterns); use
  agent prompts to constrain which sites an agent should consult.
