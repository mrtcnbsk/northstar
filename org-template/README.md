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
`org_status` — it loads and validates `organization.jsonc`, cross-checks it
against the configured agents, and lists runs.

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

## Budget

`organization.jsonc` has an optional top-level `"budget"` block (all fields
optional; USD, `retries` is an integer count):

```jsonc
"budget": { "run": 50, "stage": 15, "escalationThreshold": 10, "retries": 2 }
```

- `run` — total spend ceiling for one pipeline run.
- `stage` — default per-stage spend ceiling.
- `escalationThreshold` — spend level that triggers a human-escalation warning.
- `retries` — max retries for a stage before it is treated as failed.

Any omitted field falls back to the defaults shown above (`OrgSchema.resolveBudget`).
A single pipeline stage can override the stage ceiling by adding its own
`"budget"` number, e.g. `{ "stage": "marketing", "budget": 25 }` — this replaces
just the resolved `stage` ceiling for that stage, not `run`, `escalationThreshold`,
or `retries`. `OrgSchema.budgetWarnings` flags (without blocking load)
`stage`/`escalationThreshold` values greater than `run`.

## DAG fields (Wave 4, opt-in)

`organization.jsonc` pipeline stages support optional dependency/scheduling fields.
None of them change behavior unless set - an org with no DAG fields runs exactly as
before (fully sequential, linear pipeline):

- `pipeline[].requires` - stage names this stage depends on. Omitted defaults to
  `[previousStage]` (the immediately-preceding pipeline entry, i.e. today's linear
  chain); the first stage defaults to `[]`. An explicit `requires: []` marks an
  intentional root (stays `[]`, is not defaulted). A non-empty list lets independent
  stages (e.g. `frontend`/`backend`) share the same upstream `requires` and become
  eligible to run concurrently. `OrgSchema.resolveRequires(org)` computes the full
  resolved map; `OrgSchema.validate(org)` rejects dangling references and dependency
  cycles (reporting the cycle path, e.g. `a -> b -> a`).
- `pipeline[].timeoutMs` - per-stage wall-clock timeout in milliseconds. A running
  stage past this timeout with no valid deliverable is retried and eventually failed
  instead of hanging indefinitely.
- `pipeline[].when` - declarative skip condition that runs the stage ONLY when the
  condition matches - it is a positive-equality test, not a "skip if" test. Either
  `{ "mode": "X" }` (runs the stage only when the run's mode, set once at
  `org_start`, is exactly `"X"`; an **unset mode never matches**, so a stage gated
  this way is skipped by default on a normal run) or
  `{ "stage": "...", "decision": "approve" | "no-go" | "revise" }` (runs the stage
  only when the named prior stage recorded that exact decision; that stage must be
  one of this stage's `requires` ancestors - `OrgSchema.validate` rejects a
  `when.stage` that isn't a transitive dependency, since a sibling's decision can
  still be `undefined` when this stage is evaluated). When `when` evaluates false
  the stage is marked `"skipped"` - it still satisfies dependents but incurs no
  cost and produces no deliverable. **Caution:** because `{ "mode": "X" }` defaults
  to skip, never put `when` on a stage whose deliverable is a required pipeline
  output - reserve it for genuinely optional extra work (e.g. an in-depth audit
  stage gated on `when: { "mode": "deep" }` that a normal run intentionally
  skips).
- `maxConcurrency` (org-level, top-level key alongside `budget`) - max stages the
  runner runs concurrently per batch. Default `1` (sequential, current behavior);
  set to `>1` on a template that also declares parallel `requires` to actually
  parallelize independent stages.

As of W4.7, the shipped template pipeline is a live diamond, not just linear: `backend`
and `frontend` both set `requires: ["ux"]` (instead of defaulting to their previous
pipeline entry) and so become siblings once `ux` completes; `testing` explicitly sets
`requires: ["backend", "frontend"]` and only starts once both branches are done. The
org sets `maxConcurrency: 2` so the runner actually dispatches `backend` and `frontend`
in the same batch instead of just resolving them as both-ready. Every other stage
(`evaluation`, `planning`, `ux`, `debugging`, `marketing`) keeps the default
previous-stage `requires` - the diamond is the pipeline's only branch point.
`marketing` carries no `when` condition: it is the terminal App-Store deliverable
(ASO/copy/pricing/preview package) this org exists to produce, so every run drives it
to completion (subject to its own `gate: "human"` approval) rather than skipping it.
No `timeoutMs` is set on any stage yet.

## Editing the organization

- Add/remove workers: edit the department in `organization.jsonc` AND the chief's
  `subordinates` list AND create the worker's markdown file. `org_status` reports
  inconsistencies.
- Permission rule maps are order-sensitive (last match wins): keep `"*": deny`
  as the FIRST entry and specific allows after it.
- `webfetch`/`websearch` permissions are on/off switches (no URL patterns); use
  agent prompts to constrain which sites an agent should consult.
