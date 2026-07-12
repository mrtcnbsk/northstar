# Content Studio

A 5-agent organization (CEO -> editorial-chief -> writer/editor/fact-checker)
that takes a content brief to a drafted, edited, and fact-checked piece, with
one human gate before the run completes.

editorial-chief chiefs all three pipeline stages: "draft", "edit", and
"review" — see `agents/editorial-chief.md`.

## Install into a project

```bash
cd /path/to/your-project
northstar org init --template content-studio
```

## Run

From the project directory, start the CLI and run:

```
/write <your content brief>
```

Resume after an interruption: `/write --resume <run-id>`
Inspect without advancing: `/write --status` (or with a run id)

## State and deliverables

Everything lives under `.kilo/org/runs/<run-id>/`:
- `state.json` — pipeline state machine (resumable at any time)
- `deliverables/draft.md` — the first draft
- `deliverables/edit.md` — the revised, publication-ready copy
- `deliverables/review.md` — the fact-check verdict (GO/NO-GO)

## Models

Each agent pins its model in its frontmatter (`model: provider/model-id`).
CEO/chief use `anthropic/claude-fable-5`; writer/editor/fact-checker use
`anthropic/claude-sonnet-5`. Change any agent's file to change its model.

## Budget

`organization.jsonc` has a `"budget"` block (all fields optional; USD,
`retries` is an integer count) — see `templates/ios-app-factory/README.md` in
this repo for the full field docs and the optional DAG fields
(`requires`/`when`/`timeoutMs`/`maxConcurrency`).
