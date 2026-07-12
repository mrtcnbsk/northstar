# Blank Organization

The minimal valid organization: a CEO, one chief ("lead"), and one worker,
running a single ungated pipeline stage. Use this as a starting point for a
custom org rather than hand-writing `organization.jsonc` and agent files from
scratch.

## Install into a project

```bash
cd /path/to/your-project
northstar org init --template blank
```

## Run

From the project directory, start the CLI and run:

```
/run <your task in one or two sentences>
```

Resume after an interruption: `/run --resume <run-id>`
Inspect without advancing: `/run --status` (or with a run id)

## State and deliverables

Everything lives under `.kilo/org/runs/<run-id>/`:
- `state.json` — pipeline state machine (resumable at any time)
- `deliverables/work.md` — the department's output

## Growing this template

- Add departments: add an entry to `departments` in `organization.jsonc`, add
  a matching entry to `pipeline`, create the chief's and workers' agent
  files, and add the chief to `ceo.md`'s `subordinates`.
- Add workers to an existing department: add the worker to the department's
  `workers` array AND to that department's chief's `subordinates` list, and
  create the worker's markdown file.
- Add a human approval gate on a stage: add `"gate": "human"` (and
  `"haltOn": "no-go"` if a no-go should stop the run) to that stage in
  `pipeline`.
- See `templates/ios-app-factory/README.md` in this repo for the full set of
  optional fields (budget, DAG `requires`/`when`/`timeoutMs`, `maxConcurrency`).
