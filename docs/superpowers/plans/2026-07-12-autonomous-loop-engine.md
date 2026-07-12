# Autonomous Loop Engine (SP1) Implementation Plan

> **For Codex:** Execute this plan task-by-task with TDD. Keep `OrgRunner` as the source of truth for DAG, budget, retry, note-consumption, and gate semantics; the conductor only drives it.

**Goal:** After one approved plan, drive an organization run autonomously through measurable evaluator loops, pausing only for exhausted criteria loops or irreversible/final actions.

**Architecture:** Add a pure evaluator and irreversible-action policy, extend persisted state compatibly, then introduce a deterministic `OrgConductor` whose model/session calls are injected. Expose the same guarded mutations through the CEO tool registry and run-scoped HTTP commands, and attach a headless driver without moving existing runner invariants.

**Tech Stack:** Bun, TypeScript, Zod/Effect Schema, existing `OrgRunner`/`OrgState`, Effect HttpApi.

---

## Task 1: Pure evaluator and irreversible policy

**Files:**

- Create: `packages/opencode/src/kilocode/organization/evaluator.ts`
- Create: `packages/opencode/src/kilocode/organization/irreversible.ts`
- Create: `packages/opencode/test/kilocode/organization/evaluator.test.ts`
- Create: `packages/opencode/test/kilocode/organization/irreversible.test.ts`

1. Write failing tests for prompt checklist/output contract; fenced/plain JSON verdicts; malformed fail-safe; and explicit stage/tool denylist classification.
2. Run the two focused tests and confirm the expected import/assertion failures.
3. Implement `OrgEvaluator.prompt`, strict `OrgEvaluator.parse`, and `OrgIrreversible` pure predicates with no side effects.
4. Run focused tests and package typecheck.
5. Commit: `feat(org): add autonomous evaluator policy`.

## Task 2: Backward-compatible authoring and run state

**Files:**

- Modify: `packages/opencode/src/kilocode/organization/schema.ts`
- Modify: `packages/opencode/src/kilocode/organization/state.ts`
- Modify: `packages/opencode/test/kilocode/organization/schema.test.ts`
- Modify: `packages/opencode/test/kilocode/organization/state.test.ts`

1. Write failing tests for `criteria`, `irreversible`, loop defaults/config, `paused`, `pausedReason`, `auto`, iteration history, legacy state parsing, and selectors.
2. Extend optional schemas and add `OrgSchema.resolveLoop`, `OrgState.isIrreversible`, and paused-run selection without changing legacy defaults.
3. Snapshot stage criteria at run creation while keeping every new persisted field optional.
4. Run focused schema/state/runner regression tests and typecheck.
5. Commit: `feat(org): persist autonomous loop state`.

## Task 3: Runner-safe autonomous transition API

**Files:**

- Modify: `packages/opencode/src/kilocode/organization/runner.ts`
- Modify: `packages/opencode/src/kilocode/organization/audit.ts`
- Create: `packages/opencode/test/kilocode/organization/autonomous-runner.test.ts`

1. Write failing tests for approving an evaluated stage, reopening it with evaluator reasons, pausing escalation/final gate, resuming, and preserving budget/stop short-circuits.
2. Add narrow runner methods for plan commit, evaluator verdict application, pause, and resume. All methods must use existing `OrgState.update`, pipeline guards, deliverable hashing, and audit append behavior.
3. Ensure `advance` short-circuits paused runs and normal non-auto behavior remains byte-compatible.
4. Run autonomous tests plus the complete existing runner suite.
5. Commit: `feat(org): add autonomous runner transitions`.

## Task 4: Deterministic conductor

**Files:**

- Create: `packages/opencode/src/kilocode/organization/conductor.ts`
- Create: `packages/opencode/test/kilocode/organization/conductor.test.ts`

1. Write scripted-dependency tests for pass-first-try, revise-then-pass, loop exhaustion escalation, explicit/gated irreversible final gate, budget halt, stop halt, concurrent ready stages, and resume.
2. Implement `OrgConductor.drive` with injected `spawnChief`, `evaluate`, `readDeliverable`, clock, and event emitter.
3. Route every state transition through the Task 3 runner API; never mutate state directly in the conductor.
4. Bound each stage by `resolveLoop(org).maxIterations`, fail closed on evaluator errors, and emit deterministic ordered events.
5. Run focused tests, runner regressions, and typecheck.
6. Commit: `feat(org): drive deterministic autonomous loops`.

## Task 5: Approved plan protocol and CEO tool

**Files:**

- Modify: `packages/opencode/src/kilocode/organization/tools.ts`
- Modify: `packages/opencode/src/kilocode/tool/registry.ts`
- Modify: `packages/opencode/src/kilocode/organization/prompts.ts`
- Create: `packages/opencode/test/kilocode/organization/org-plan.test.ts`

1. Write failing tests for CEO-only access, per-stage validation, atomic criteria commit, editable re-emission before approval, and the approval handoff to `auto=true`.
2. Implement `org_plan` using the existing run lock and result conventions.
3. Register the tool without changing existing tool IDs or non-CEO permissions.
4. Update the CEO protocol prompt to generate objective/criteria/agents once and wait for approval.
5. Run focused tool/registry/prompt tests and typecheck.
6. Commit: `feat(org): add approved autonomous plan protocol`.

## Task 6: Run-scoped HTTP command endpoints

**Files:**

- Modify: `packages/opencode/src/kilocode/server/httpapi/groups/org-runs.ts`
- Modify: `packages/opencode/src/kilocode/server/httpapi/handlers/org-runs.ts`
- Modify: `packages/opencode/test/kilocode/server/httpapi-org-runs.test.ts`
- Create: `packages/opencode/test/kilocode/server/org-runs-commands.test.ts`

1. Write failing HTTP tests for plan, decision, note, stop, pause, and resume happy paths; invalid bodies; unknown/traversal run IDs; wrong-stage decisions; and corrupt state.
2. Add typed POST endpoints under `/org-runs/:runID/*`, protected by the existing authorization/workspace middleware.
3. Load and validate the active organization for every mutation, use the same run lock as tools, and map only genuine `OrgState.NotFound` errors to 404.
4. Keep command handlers thin: delegate to `OrgRunner`/`OrgNote` and return updated run state.
5. Run focused server tests and HttpApi typecheck.
6. Commit: `feat(org): expose autonomous run controls`.

## Task 7: Conductor events and observable detail

**Files:**

- Modify: `packages/opencode/src/kilocode/organization/audit.ts`
- Modify: `packages/opencode/src/kilocode/server/httpapi/groups/org-runs.ts`
- Modify: `packages/opencode/src/kilocode/server/httpapi/handlers/org-runs.ts`
- Modify: `packages/opencode/test/kilocode/server/httpapi-org-runs.test.ts`

1. Write failing tests proving criteria, iterations, verdict history, pause reason, loop config/model, and conductor events are returned by run detail while legacy records still decode.
2. Extend the audit entry schema additively with typed conductor event metadata.
3. Extend detail response schemas and builders without re-deriving state or cost math.
4. Run server, audit, and state regressions.
5. Commit: `feat(org): surface autonomous loop telemetry`.

## Task 8: Headless driver wiring

**Files:**

- Create: `packages/opencode/src/kilocode/organization/driver.ts`
- Modify: the existing CLI/session `run --auto` entry point located during implementation
- Modify: HTTP resume handler from Task 6
- Create: `packages/opencode/test/kilocode/organization/driver.test.ts`

1. Write failing tests for single-flight drive attachment, re-entry after pause, chief session adaptation, evaluator model selection, and event persistence.
2. Adapt existing session/task primitives to `OrgConductor.Deps`; do not grant evaluator side-effect tools.
3. Start the driver after plan approval and resume; keep non-auto CLI behavior unchanged.
4. Prove duplicate attach/resume calls cannot run two conductors for one run in-process.
5. Run focused driver/CLI tests and typecheck.
6. Commit: `feat(org): attach headless autonomous driver`.

## Task 9: SP1 exit test and release closure

**Files:**

- Create: `packages/opencode/test/kilocode/organization/autonomous-loop-exit.test.ts`
- Modify: representative organization templates to add criteria and irreversible flags
- Modify: `docs/superpowers/tracked-followups.md`
- Create: `.changeset/<generated-name>.md`

1. Add an end-to-end scripted run that approves a plan, revises once, passes, pauses at final gate, resumes after approval, and completes; add a separate exhausted-loop escalation assertion.
2. Run every new SP1 test, the full organization test directory, server HTTP tests, package typecheck, annotation check, Markdown checks, and root lint/typecheck sweep.
3. Perform the four-dimension adversarial close: correctness, safety/irreversibility, compatibility, and operational failure recovery; record any genuine deferrals.
4. Add a patch changeset and tracked-followup closure entry.
5. Commit: `feat(org): complete autonomous loop engine`.

## Verification commands

```bash
cd packages/opencode
bun test test/kilocode/organization
bun test test/kilocode/server/httpapi-org-runs.test.ts test/kilocode/server/org-runs-commands.test.ts
bun run typecheck

cd ../..
bun run check:opencode-annotations
bun run check:md-table-padding
bun run lint
bun run typecheck
git diff --check
```

Expected environment caveat: the root sweep may still fail only at JetBrains `:backend:generateOpenApiSpec` while the pinned `v0.1.0` release URL returns 404; all SP1/package-local checks must be green.
