# Agent Organization Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hierarchical multi-agent organization core on the northstar fork: a controlled CEO→chief→worker delegation patch, a deterministic pipeline runner with two human gates, and the full 26-agent org chart as copyable config templates.

**Architecture:** Three layers. (1) A minimal, `// kilocode_change`-marked core patch that lets "manager" subagents (those with `task` allow rules) spawn their own subagents, capped at depth 2, with a `subordinates:` frontmatter field that expands into ordered task-permission rules. (2) A new self-contained module `packages/opencode/src/kilocode/organization/` (zod schemas, file-based run state machine, deliverable validation, stage prompt builder, and four `org_*` tools) — the runner enforces pipeline order/gates in code; the CEO LLM only synthesizes and talks to the user. (3) A repo-root `org-template/` directory holding `organization.jsonc`, 26 agent markdown files, and the `/build-app` command, which users copy into an app project's `.kilo/` directory.

**Tech Stack:** Bun + TypeScript, Effect (only at tool boundaries), zod (pure modules), `jsonc-parser`, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-07-09-agent-organization-core-design.md` (approved).

---

## Repo primer (read first)

- Work happens in `/Users/mertcanbasak/Now/northstar`, branch `feat/agent-organization` (already created).
- **Read `AGENTS.md` at the repo root before starting.** Hard rule enforced by CI: Kilo-specific code lives in `kilocode/`-named paths, and every edit to a shared (upstream) file must be wrapped in `// kilocode_change` / `// kilocode_change start` + `// kilocode_change end` markers.
- Package manager is **bun**. Run tests from `packages/opencode/`: `bun test test/<path>.test.ts`. Typecheck from repo root: `bun turbo typecheck`.
- Permission rule evaluation is **last-match-wins**: `PermissionV2.evaluate` (in `packages/core/src/permission.ts:21`) uses `findLast` over the flattened rulesets. Rule ORDER inside a ruleset is therefore load-bearing everywhere in this plan: put `"*": deny` FIRST and specific allows AFTER it.
- Existing test conventions: `bun:test` (`describe/test/expect`), `tmpdir` fixture from `packages/opencode/test/fixture/fixture.ts` (see `packages/opencode/test/AGENTS.md`), `testEffect` harness from `test/lib/effect.ts` for Effect-service tests. New organization modules are deliberately plain async TypeScript (no Effect) so tests stay simple.
- Commit after every task. Commit messages: conventional (`feat:`, `test:`, `docs:`), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File structure (what gets created/modified)

```
packages/opencode/src/kilocode/organization/     (NEW — Kilo-safe, no markers needed)
  schema.ts      org chart config: zod schema, jsonc load, validate, crossCheck
  state.ts       run state: create/read/write state.json, atomic writes
  artifacts.ts   deliverable paths + validation
  prompts.ts     stage prompt builder (chief task prompts)
  runner.ts      pure state machine: start/advance/decide/status
  depth.ts       delegation depth guard (used by src/tool/task.ts)
  tools.ts       org_start / org_advance / org_decision / org_status Tool.define adapters

packages/opencode/src/kilocode/tool/task.ts      (MODIFY — already a kilocode file)
packages/opencode/src/tool/task.ts               (MODIFY — shared file, markers required)
packages/opencode/src/config/agent.ts            (MODIFY — shared file, markers required)
packages/opencode/src/kilocode/tool/registry.ts  (MODIFY — kilocode file)

packages/opencode/test/kilocode/organization/    (NEW tests)
  depth.test.ts, nested-task.test.ts, subordinates.test.ts, schema.test.ts,
  state.test.ts, artifacts.test.ts, prompts.test.ts, runner.test.ts, template.test.ts

org-template/                                    (NEW — repo root, user copies into project .kilo/)
  organization.jsonc
  agents/*.md        (26 files)
  command/build-app.md
  README.md
```

---

### Task 1: Baseline — install and verify existing tests pass

**Files:** none modified.

- [ ] **Step 1: Install dependencies**

Run from repo root:
```bash
cd /Users/mertcanbasak/Now/northstar && bun install
```
Expected: completes without errors (patches applied via `patches/`, postinstall runs).

- [ ] **Step 2: Verify the existing task-related tests are green (baseline)**

```bash
cd packages/opencode && bun test test/permission-task.test.ts test/tool/task.test.ts
```
Expected: all tests PASS. If they fail on a clean checkout, STOP and report — do not proceed on a red baseline.

---

### Task 2: Delegation depth guard

**Files:**
- Create: `packages/opencode/src/kilocode/organization/depth.ts`
- Test: `packages/opencode/test/kilocode/organization/depth.test.ts`

The guard computes how deep a session sits in the parent chain (root = 0) by walking `parentID` links through an injected getter (structural typing — avoids importing Session service into a pure module). Spawning from depth `d` creates a child at `d+1`; we reject when `d+1 > 2`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/depth.test.ts
import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { OrgDepth } from "../../../src/kilocode/organization/depth"

type Node = { parentID?: string }

function getter(tree: Record<string, Node>) {
  return (id: string) =>
    tree[id] ? Effect.succeed(tree[id]) : Effect.fail(new Error(`unknown session ${id}`))
}

describe("OrgDepth", () => {
  const tree: Record<string, Node> = {
    root: {},
    chief: { parentID: "root" },
    worker: { parentID: "chief" },
  }

  test("depthOf returns 0 for a root session", async () => {
    expect(await Effect.runPromise(OrgDepth.depthOf(getter(tree), "root"))).toBe(0)
  })

  test("depthOf returns 1 for a chief session, 2 for a worker session", async () => {
    expect(await Effect.runPromise(OrgDepth.depthOf(getter(tree), "chief"))).toBe(1)
    expect(await Effect.runPromise(OrgDepth.depthOf(getter(tree), "worker"))).toBe(2)
  })

  test("guard allows spawning from root and chief sessions", async () => {
    await Effect.runPromise(OrgDepth.guard(getter(tree), "root"))
    await Effect.runPromise(OrgDepth.guard(getter(tree), "chief"))
  })

  test("guard rejects spawning from a worker session (would exceed depth 2)", async () => {
    const exit = await Effect.runPromiseExit(OrgDepth.guard(getter(tree), "worker"))
    expect(exit._tag).toBe("Failure")
  })

  test("depthOf stops at MAX_WALK even on a corrupt cyclic chain", async () => {
    const cyclic: Record<string, Node> = { a: { parentID: "b" }, b: { parentID: "a" } }
    const depth = await Effect.runPromise(OrgDepth.depthOf(getter(cyclic), "a"))
    expect(depth).toBe(OrgDepth.MAX_WALK)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/depth.test.ts
```
Expected: FAIL — cannot resolve module `.../organization/depth`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/kilocode/organization/depth.ts
// kilocode_change - new file
import { Effect } from "effect"

/**
 * Delegation depth guard for the agent-organization hierarchy.
 * Depth is the number of parent hops to the root session:
 *   CEO (root) = 0, chief = 1, worker = 2.
 * Spawning a subagent from depth d creates a session at depth d+1;
 * anything past MAX_DELEGATION_DEPTH is rejected so workers can never
 * spawn their own subagents even if misconfigured with task permissions.
 */
export namespace OrgDepth {
  export const MAX_DELEGATION_DEPTH = 2
  /** Hard cap on parent-chain walks; protects against corrupt/cyclic data. */
  export const MAX_WALK = 8

  type Getter = (id: string) => Effect.Effect<{ parentID?: string | undefined }, unknown>

  export function depthOf(get: Getter, sessionID: string): Effect.Effect<number, unknown> {
    return Effect.gen(function* () {
      let depth = 0
      let current = yield* get(sessionID)
      while (current.parentID && depth < MAX_WALK) {
        depth++
        current = yield* get(current.parentID)
      }
      return depth
    })
  }

  export function guard(get: Getter, sessionID: string): Effect.Effect<void, unknown> {
    return Effect.gen(function* () {
      const depth = yield* depthOf(get, sessionID)
      if (depth + 1 > MAX_DELEGATION_DEPTH) {
        return yield* Effect.fail(
          new Error(
            `Delegation depth limit reached: this session is already ${depth} level(s) deep ` +
              `(max hierarchy: CEO -> chief -> worker). Workers cannot spawn subagents.`,
          ),
        )
      }
    })
  }
}
```

Note the cyclic test: with `MAX_WALK = 8`, walking `a -> b -> a -> ...` increments depth to 8 and exits the loop — no infinite loop, and `guard` correctly rejects.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/opencode && bun test test/kilocode/organization/depth.test.ts
```
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/depth.ts packages/opencode/test/kilocode/organization/depth.test.ts
git commit -m "feat(org): delegation depth guard (max CEO->chief->worker)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Manager-aware `nestedTask` and conditional task-deny

**Files:**
- Modify: `packages/opencode/src/kilocode/tool/task.ts:39-42` (`nestedTask`) and `:72-80` (`permissions`)
- Test: `packages/opencode/test/kilocode/organization/nested-task.test.ts`

Today `KiloTask.nestedTask()` returns `false` unconditionally and `KiloTask.permissions()` unconditionally prepends `{task,*,deny}`. Change both to honor a "manager" subagent — one whose own ruleset carries any non-deny `task` rule (which is exactly what the `subordinates` expansion in Task 5 produces). This mirrors the `canTask` escape that already exists in `deriveSubagentSessionPermission` (`packages/opencode/src/agent/subagent-permissions.ts:22`).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/nested-task.test.ts
import { describe, test, expect } from "bun:test"
import { KiloTask } from "../../../src/kilocode/tool/task"
import { deriveSubagentSessionPermission } from "../../../src/agent/subagent-permissions"
import type { Agent } from "../../../src/agent/agent"

function agent(permission: Agent.Info["permission"]): Agent.Info {
  return { name: "x", mode: "subagent", permission, options: {} } as Agent.Info
}

describe("KiloTask.nestedTask", () => {
  test("false for a plain worker (no task rules)", () => {
    expect(KiloTask.nestedTask(agent([]))).toBe(false)
  })

  test("false when the only task rules are denies", () => {
    expect(KiloTask.nestedTask(agent([{ permission: "task", pattern: "*", action: "deny" }]))).toBe(false)
  })

  test("true for a manager with a task allow rule", () => {
    expect(
      KiloTask.nestedTask(
        agent([
          { permission: "task", pattern: "*", action: "deny" },
          { permission: "task", pattern: "swiftui-dev-1", action: "allow" },
        ]),
      ),
    ).toBe(true)
  })
})

describe("KiloTask.permissions", () => {
  test("default: prepends task deny (workers)", () => {
    const rules = KiloTask.permissions([])
    expect(rules.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)
  })

  test("canTask: omits the task deny but keeps question/interactive_terminal denies", () => {
    const rules = KiloTask.permissions([], { canTask: true })
    expect(rules.some((r) => r.permission === "task")).toBe(false)
    expect(rules.some((r) => r.permission === "question" && r.action === "deny")).toBe(true)
    expect(rules.some((r) => r.permission === "interactive_terminal" && r.action === "deny")).toBe(true)
  })
})

describe("transitive permission ceiling across 3 levels (existing derive logic composes)", () => {
  test("a CEO edit deny survives CEO -> chief -> worker", () => {
    const ceo = agent([{ permission: "edit", pattern: "*", action: "deny" }])
    const chief = agent([
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "task", pattern: "worker", action: "allow" },
    ])
    const worker = agent([])

    // hop 1: CEO spawns chief — chief session inherits CEO's edit deny, no task deny (manager)
    const chiefSession = deriveSubagentSessionPermission({
      parentSessionPermission: [],
      parentAgent: ceo,
      subagent: chief,
    })
    expect(chiefSession.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
    expect(chiefSession.some((r) => r.permission === "task" && r.action === "deny")).toBe(false)

    // hop 2: chief spawns worker — the CEO deny still forwards; the worker gets the task deny back
    const workerSession = deriveSubagentSessionPermission({
      parentSessionPermission: chiefSession,
      parentAgent: chief,
      subagent: worker,
    })
    expect(workerSession.some((r) => r.permission === "edit" && r.action === "deny")).toBe(true)
    expect(workerSession.some((r) => r.permission === "task" && r.action === "deny")).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/nested-task.test.ts
```
Expected: FAIL — `nestedTask` takes no argument today and always returns `false`; `permissions` has no options parameter.

- [ ] **Step 3: Implement in `packages/opencode/src/kilocode/tool/task.ts`**

Replace the current `nestedTask` (lines 39-42):

```typescript
  /**
   * Kilo historically kept delegation one level deep. The agent-organization
   * layer relaxes this for "manager" subagents only: a subagent whose own
   * ruleset carries a non-deny task rule (produced by the `subordinates`
   * frontmatter field) may spawn its declared subordinates. Depth is
   * separately capped by OrgDepth.guard in the task tool.
   */
  export function nestedTask(subagent: Agent.Info): boolean {
    return subagent.permission.some((rule) => rule.permission === "task" && rule.action !== "deny")
  }
```

Replace the current `permissions` (lines 72-80):

```typescript
  /** Extra permission rules appended to subagent sessions */
  export function permissions(rules: Permission.Ruleset, opts?: { canTask?: boolean }): Permission.Ruleset {
    return [
      ...(opts?.canTask ? [] : [{ permission: "task", pattern: "*", action: "deny" } as const]),
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "interactive_terminal", pattern: "*", action: "deny" },
      ...rules,
    ]
  }
```

(The file is already `// kilocode_change - new file`; no extra markers needed.)

- [ ] **Step 4: Find and update all call sites**

```bash
cd packages/opencode && grep -rn "nestedTask\|KiloTask.permissions" src/ --include="*.ts"
```
Expected call sites (verify — if others appear, update them the same way):
- `src/tool/task.ts:161` — `const canTask = KiloTask.nestedTask()` → done in Task 4, leave for now (it will not compile until Task 4; that is why Tasks 3+4 commit together — see Step 6).
- `src/tool/task.ts:191` and `:217` — `KiloTask.permissions(rules)` → done in Task 4.

- [ ] **Step 5: Run the new unit tests**

```bash
cd packages/opencode && bun test test/kilocode/organization/nested-task.test.ts
```
Expected: 7 pass. (These tests exercise the kilocode module directly and do not require the task.ts call sites to be updated yet.)

- [ ] **Step 6: Do NOT commit yet** — Task 4 updates the call sites; commit both together so the tree always typechecks.

---

### Task 4: Wire manager delegation + depth guard into the task tool

**Files:**
- Modify: `packages/opencode/src/tool/task.ts` (shared upstream file — every change wrapped in markers)

- [ ] **Step 1: Add the import**

Near the other kilocode imports at the top (after line 22 `import * as SandboxPolicy ...`):

```typescript
import { OrgDepth } from "@/kilocode/organization/depth" // kilocode_change
```

- [ ] **Step 2: Update the canTask computation (line 161)**

Replace:
```typescript
      const canTask = KiloTask.nestedTask() // kilocode_change - Kilo disallows subagents spawning subagents
```
with:
```typescript
      const canTask = KiloTask.nestedTask(next) // kilocode_change - manager subagents (subordinates) may delegate
```

- [ ] **Step 3: Add the depth guard right after the canTask line**

```typescript
      // kilocode_change start - enforce max delegation depth (CEO -> chief -> worker)
      yield* OrgDepth.guard((id) => sessions.get(SessionID.make(id)), ctx.sessionID)
      // kilocode_change end
```

- [ ] **Step 4: Thread canTask into both `KiloTask.permissions` calls**

Line ~191 (resume path):
```typescript
          KiloTask.permissions(rules, { canTask }),
```
Line ~217 (create path):
```typescript
            KiloTask.permissions(rules, { canTask }),
```
(Both already sit inside existing `kilocode_change` blocks — no new markers needed there.)

- [ ] **Step 5: Typecheck and run the task test suites**

```bash
cd /Users/mertcanbasak/Now/northstar && bun turbo typecheck
cd packages/opencode && bun test test/tool/task.test.ts test/permission-task.test.ts test/kilocode/organization/
```
Expected: typecheck clean; all tests pass. If `test/tool/task.test.ts` constructs agents without task rules, behavior is unchanged (canTask=false → same denies as before). If any test stubs `nestedTask`, update the stub to the new signature.

- [ ] **Step 6: Commit Tasks 3+4 together**

```bash
git add packages/opencode/src/kilocode/tool/task.ts packages/opencode/src/tool/task.ts packages/opencode/test/kilocode/organization/nested-task.test.ts
git commit -m "feat(org): allow manager subagents to delegate, capped at depth 2

nestedTask() now detects manager subagents (non-deny task rules) instead
of returning false unconditionally; the session-level task deny is skipped
for them (mirrors the existing canTask escape in subagent-permissions).
OrgDepth.guard walks the DB parent chain so workers can never spawn.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `subordinates` frontmatter field

**Files:**
- Modify: `packages/opencode/src/config/agent.ts` (shared file — markers required)
- Test: `packages/opencode/test/kilocode/organization/subordinates.test.ts`

`subordinates: [a, b]` expands into ordered task-permission config: `{ task: { "*": "deny", a: "allow", b: "allow" } }`. Order matters (last-match-wins): the `"*": deny` entry MUST be inserted first. Explicit `permission.task` in the same file wins over the expansion.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/subordinates.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import * as ConfigAgent from "../../../src/config/agent"

async function writeAgent(dir: string, name: string, body: string) {
  await mkdir(path.join(dir, "agents"), { recursive: true })
  await Bun.write(path.join(dir, "agents", `${name}.md`), body)
}

describe("subordinates frontmatter expansion", () => {
  test("expands into ordered task permission (deny-all first, allows after)", async () => {
    await using tmp = await tmpdir()
    await writeAgent(
      tmp.path,
      "frontend-chief",
      [
        "---",
        "description: chief",
        "mode: subagent",
        "subordinates: [swiftui-dev-1, apple-docs]",
        "---",
        "You manage the frontend team.",
      ].join("\n"),
    )
    const result = await ConfigAgent.load(tmp.path)
    const chief = result["frontend-chief"]
    expect(chief).toBeDefined()
    const task = chief.permission?.task as Record<string, string>
    expect(task).toBeDefined()
    const entries = Object.entries(task)
    expect(entries[0]).toEqual(["*", "deny"])
    expect(task["swiftui-dev-1"]).toBe("allow")
    expect(task["apple-docs"]).toBe("allow")
  })

  test("explicit permission.task wins over subordinates expansion", async () => {
    await using tmp = await tmpdir()
    await writeAgent(
      tmp.path,
      "custom-chief",
      [
        "---",
        "description: chief",
        "mode: subagent",
        "subordinates: [worker-a]",
        "permission:",
        "  task:",
        '    "*": deny',
        "---",
        "Prompt.",
      ].join("\n"),
    )
    const result = await ConfigAgent.load(tmp.path)
    const task = result["custom-chief"].permission?.task as Record<string, string>
    expect(task["worker-a"]).toBeUndefined()
  })

  test("agents without subordinates get no task rules from expansion", async () => {
    await using tmp = await tmpdir()
    await writeAgent(tmp.path, "worker", "---\ndescription: worker\nmode: subagent\n---\nPrompt.")
    const result = await ConfigAgent.load(tmp.path)
    expect(result["worker"].permission?.task).toBeUndefined()
  })

  test("subordinates does not leak into options", async () => {
    await using tmp = await tmpdir()
    await writeAgent(tmp.path, "chief", "---\nmode: subagent\nsubordinates: [w]\n---\nP.")
    const result = await ConfigAgent.load(tmp.path)
    expect((result["chief"].options ?? {})["subordinates"]).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/subordinates.test.ts
```
Expected: FAIL — `subordinates` is unknown, lands in `options`, and no task permission is produced.

- [ ] **Step 3: Implement in `packages/opencode/src/config/agent.ts`**

3a. Add the schema field inside `AgentSchema`'s struct (after the `requirements` line, ~line 73):

```typescript
    // kilocode_change start - agent-organization: declared subordinates expand to task permissions
    subordinates: Schema.optional(Schema.Array(Schema.String)).annotate({
      description: "Agent names this agent may spawn via the task tool (expands to ordered task permission rules)",
    }),
    // kilocode_change end
```

3b. Add `"subordinates", // kilocode_change` to the `KNOWN_KEYS` set (~line 78-98).

3c. In `normalize` (~line 106-127), after the `tools` translation loop and BEFORE `globalThis.Object.assign(permission, agent.permission)`, insert:

```typescript
  // kilocode_change start - expand subordinates into ordered task rules ("*" deny first;
  // last-match-wins evaluation makes the later specific allows win). Explicit
  // permission.task in the same file takes precedence via the assign below.
  if (agent.subordinates?.length) {
    permission.task = {
      "*": "deny",
      ...globalThis.Object.fromEntries(agent.subordinates.map((name) => [name, "allow" as const])),
    }
  }
  // kilocode_change end
```

(No change needed in `src/agent/agent.ts`: the merge loop at line ~346 already runs `Permission.fromConfig(value.permission ?? {})`, and `fromConfig` — `src/permission/index.ts:487` — preserves insertion order, emitting the deny before the allows.)

- [ ] **Step 4: Run tests**

```bash
cd packages/opencode && bun test test/kilocode/organization/subordinates.test.ts
cd packages/opencode && bun test test/agent/
cd /Users/mertcanbasak/Now/northstar && bun turbo typecheck
```
Expected: new tests pass; existing agent tests still pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/config/agent.ts packages/opencode/test/kilocode/organization/subordinates.test.ts
git commit -m "feat(org): subordinates frontmatter expands to ordered task permissions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Organization config schema

**Files:**
- Create: `packages/opencode/src/kilocode/organization/schema.ts`
- Test: `packages/opencode/test/kilocode/organization/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/schema.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgSchema } from "../../../src/kilocode/organization/schema"

const VALID = {
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [
    { stage: "evaluation", gate: "human", haltOn: "no-go" },
    { stage: "planning", gate: "human" },
  ],
}

describe("OrgSchema.parse + validate", () => {
  test("accepts a valid organization", () => {
    const org = OrgSchema.parse(VALID)
    expect(OrgSchema.validate(org)).toEqual([])
  })

  test("rejects pipeline stage without a department", () => {
    const org = OrgSchema.parse({ ...VALID, pipeline: [...VALID.pipeline, { stage: "ghost" }] })
    expect(OrgSchema.validate(org).some((e) => e.includes("ghost"))).toBe(true)
  })

  test("rejects duplicate pipeline stages", () => {
    const org = OrgSchema.parse({ ...VALID, pipeline: [VALID.pipeline[0], VALID.pipeline[0]] })
    expect(OrgSchema.validate(org).some((e) => e.includes("duplicate"))).toBe(true)
  })

  test("rejects a chief who is also a worker (cycle/role conflict)", () => {
    const org = OrgSchema.parse({
      ...VALID,
      departments: {
        ...VALID.departments,
        planning: { chief: "eval-chief", workers: ["market-research"] },
        broken: { chief: "x-chief", workers: ["eval-chief"] },
      },
      pipeline: [{ stage: "evaluation" }, { stage: "planning" }, { stage: "broken" }],
    })
    expect(OrgSchema.validate(org).some((e) => e.includes("eval-chief"))).toBe(true)
  })

  test("rejects the ceo appearing as chief or worker", () => {
    const org = OrgSchema.parse({
      ...VALID,
      departments: { evaluation: { chief: "ceo", workers: ["market-research"] } },
      pipeline: [{ stage: "evaluation" }],
    })
    expect(OrgSchema.validate(org).some((e) => e.includes("ceo"))).toBe(true)
  })
})

describe("OrgSchema.loadOrganization", () => {
  test("loads .kilo/organization.jsonc with comments", async () => {
    await using tmp = await tmpdir()
    await mkdir(path.join(tmp.path, ".kilo"), { recursive: true })
    await Bun.write(
      path.join(tmp.path, ".kilo", "organization.jsonc"),
      `// org chart\n${JSON.stringify(VALID)}`,
    )
    const org = await OrgSchema.loadOrganization(tmp.path)
    expect(org.ceo).toBe("ceo")
    expect(org.pipeline.length).toBe(2)
  })

  test("throws a readable error when the file is missing", async () => {
    await using tmp = await tmpdir()
    await expect(OrgSchema.loadOrganization(tmp.path)).rejects.toThrow(/organization\.jsonc/)
  })
})

describe("OrgSchema.crossCheck", () => {
  test("flags chiefs missing subordinates coverage and missing agents", () => {
    const org = OrgSchema.parse(VALID)
    const agents = {
      ceo: { mode: "primary", subordinates: ["eval-chief"] }, // missing planning-chief
      "eval-chief": { mode: "subagent", subordinates: ["market-research", "apple-docs"] },
      // planning-chief missing entirely; architect missing
      "market-research": { mode: "subagent" },
      "apple-docs": { mode: "subagent" },
    }
    const errors = OrgSchema.crossCheck(org, agents)
    expect(errors.some((e) => e.includes("planning-chief"))).toBe(true)
    expect(errors.some((e) => e.includes("architect"))).toBe(true)
    expect(errors.some((e) => e.includes("ceo") && e.includes("planning-chief"))).toBe(true)
  })

  test("passes a fully consistent org", () => {
    const org = OrgSchema.parse(VALID)
    const agents = {
      ceo: { mode: "primary", subordinates: ["eval-chief", "planning-chief"] },
      "eval-chief": { mode: "subagent", subordinates: ["market-research", "apple-docs"] },
      "planning-chief": { mode: "subagent", subordinates: ["architect", "apple-docs"] },
      "market-research": { mode: "subagent" },
      architect: { mode: "subagent" },
      "apple-docs": { mode: "subagent" },
    }
    expect(OrgSchema.crossCheck(org, agents)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/schema.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/kilocode/organization/schema.ts
// kilocode_change - new file
import path from "path"
import z from "zod"
import { parse as parseJsonc } from "jsonc-parser"

export namespace OrgSchema {
  export const Department = z.object({
    chief: z.string().min(1),
    workers: z.array(z.string().min(1)).min(1),
  })

  export const Stage = z.object({
    stage: z.string().min(1),
    gate: z.enum(["human"]).optional(),
    haltOn: z.enum(["no-go"]).optional(),
  })

  export const Organization = z.object({
    ceo: z.string().min(1),
    departments: z.record(z.string(), Department),
    shared: z.array(z.string()).default([]),
    pipeline: z.array(Stage).min(1),
  })
  export type Organization = z.output<typeof Organization>

  export function parse(input: unknown): Organization {
    return Organization.parse(input)
  }

  /** Structural validation beyond shape: stage references, role conflicts. */
  export function validate(org: Organization): string[] {
    const errors: string[] = []
    const seen = new Set<string>()
    for (const { stage } of org.pipeline) {
      if (seen.has(stage)) errors.push(`duplicate pipeline stage "${stage}"`)
      seen.add(stage)
      if (!org.departments[stage]) errors.push(`pipeline stage "${stage}" has no matching department`)
    }
    const chiefs = new Set(Object.values(org.departments).map((d) => d.chief))
    const workers = new Set(Object.values(org.departments).flatMap((d) => d.workers))
    for (const chief of chiefs) {
      if (workers.has(chief)) errors.push(`agent "${chief}" is both a chief and a worker (role conflict)`)
    }
    if (chiefs.has(org.ceo) || workers.has(org.ceo)) {
      errors.push(`ceo agent "${org.ceo}" cannot also be a chief or worker`)
    }
    return errors
  }

  export function organizationPath(projectDir: string): string {
    return path.join(projectDir, ".kilo", "organization.jsonc")
  }

  export async function loadOrganization(projectDir: string): Promise<Organization> {
    const file = organizationPath(projectDir)
    const text = await Bun.file(file)
      .text()
      .catch(() => {
        throw new Error(
          `No organization found: expected ${file}. Copy org-template/ into your project's .kilo/ directory first.`,
        )
      })
    const raw = parseJsonc(text)
    const org = parse(raw)
    const errors = validate(org)
    if (errors.length) throw new Error(`Invalid organization.jsonc:\n- ${errors.join("\n- ")}`)
    return org
  }

  /** Cross-check the org chart against loaded agent definitions. */
  export function crossCheck(
    org: Organization,
    agents: Record<string, { mode?: string; subordinates?: readonly string[] }>,
  ): string[] {
    const errors: string[] = []
    const ceo = agents[org.ceo]
    if (!ceo) errors.push(`ceo agent "${org.ceo}" is not defined`)
    else if (ceo.mode !== "primary") errors.push(`ceo agent "${org.ceo}" must have mode: primary`)

    const chiefs = Object.values(org.departments).map((d) => d.chief)
    for (const chief of chiefs) {
      if (!agents[chief]) errors.push(`chief agent "${chief}" is not defined`)
      if (ceo && !(ceo.subordinates ?? []).includes(chief)) {
        errors.push(`ceo "${org.ceo}" is missing subordinate "${chief}"`)
      }
    }
    for (const [name, dept] of Object.entries(org.departments)) {
      const chief = agents[dept.chief]
      const required = [...dept.workers, ...org.shared]
      for (const agentName of required) {
        if (!agents[agentName]) errors.push(`agent "${agentName}" (department "${name}") is not defined`)
        if (chief && !(chief.subordinates ?? []).includes(agentName)) {
          errors.push(`chief "${dept.chief}" is missing subordinate "${agentName}"`)
        }
      }
    }
    return errors
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/opencode && bun test test/kilocode/organization/schema.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/schema.ts packages/opencode/test/kilocode/organization/schema.test.ts
git commit -m "feat(org): organization.jsonc schema, load, validate, crossCheck

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Run state store

**Files:**
- Create: `packages/opencode/src/kilocode/organization/state.ts`
- Test: `packages/opencode/test/kilocode/organization/state.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/state.test.ts
import { describe, test, expect } from "bun:test"
import { tmpdir } from "../../fixture/fixture"
import { OrgState } from "../../../src/kilocode/organization/state"
import { OrgSchema } from "../../../src/kilocode/organization/schema"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

describe("OrgState", () => {
  test("create initializes all stages pending and persists", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "a habit tracker for sailors")
    expect(run.runID).toMatch(/^\d{8}-\d{6}-/)
    expect(run.status).toBe("active")
    expect(run.stages["evaluation"].status).toBe("pending")
    expect(run.stages["planning"].status).toBe("pending")

    const loaded = await OrgState.read(tmp.path, run.runID)
    expect(loaded).toEqual(run)
  })

  test("update mutates and persists atomically", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "idea")
    const updated = await OrgState.update(tmp.path, run.runID, (s) => {
      s.stages["evaluation"].status = "running"
      s.stages["evaluation"].taskID = "ses_123"
    })
    expect(updated.stages["evaluation"].status).toBe("running")
    const loaded = await OrgState.read(tmp.path, run.runID)
    expect(loaded.stages["evaluation"].taskID).toBe("ses_123")
  })

  test("read throws a readable error for unknown run", async () => {
    await using tmp = await tmpdir()
    await expect(OrgState.read(tmp.path, "nope")).rejects.toThrow(/nope/)
  })

  test("list returns run ids, newest first", async () => {
    await using tmp = await tmpdir()
    const a = await OrgState.create(tmp.path, ORG, "first")
    await new Promise((r) => setTimeout(r, 1100)) // runID has second granularity
    const b = await OrgState.create(tmp.path, ORG, "second")
    const ids = await OrgState.list(tmp.path)
    expect(ids[0]).toBe(b.runID)
    expect(ids).toContain(a.runID)
  })

  test("slugifies the idea into the runID", async () => {
    await using tmp = await tmpdir()
    const run = await OrgState.create(tmp.path, ORG, "Deniz Feneri! App (v2)")
    expect(run.runID).toMatch(/deniz-feneri-app-v2/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/state.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/kilocode/organization/state.ts
// kilocode_change - new file
import path from "path"
import { mkdir, rename, readdir } from "node:fs/promises"
import z from "zod"
import type { OrgSchema } from "./schema"

export namespace OrgState {
  export const StageStatus = z.enum(["pending", "running", "awaiting_approval", "completed", "failed"])
  export type StageStatus = z.output<typeof StageStatus>

  export const Stage = z.object({
    status: StageStatus,
    taskID: z.string().optional(),
    cost: z.number().optional(),
    attempts: z.number().default(0),
    decision: z.enum(["approve", "no-go", "revise"]).optional(),
    decisionNote: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
  })
  export type Stage = z.output<typeof Stage>

  export const Run = z.object({
    runID: z.string(),
    idea: z.string(),
    createdAt: z.string(),
    status: z.enum(["active", "halted", "completed"]),
    haltReason: z.string().optional(),
    stages: z.record(z.string(), Stage),
  })
  export type Run = z.output<typeof Run>

  export function runsDir(projectDir: string): string {
    return path.join(projectDir, ".kilo", "org", "runs")
  }

  export function runDir(projectDir: string, runID: string): string {
    return path.join(runsDir(projectDir), runID)
  }

  function stateFile(projectDir: string, runID: string): string {
    return path.join(runDir(projectDir, runID), "state.json")
  }

  export function slugify(text: string): string {
    return (
      text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "run"
    )
  }

  function stamp(date: Date): string {
    const p = (n: number, w = 2) => String(n).padStart(w, "0")
    return (
      `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
      `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
    )
  }

  export async function create(projectDir: string, org: OrgSchema.Organization, idea: string): Promise<Run> {
    const now = new Date()
    const runID = `${stamp(now)}-${slugify(idea)}`
    const run: Run = {
      runID,
      idea,
      createdAt: now.toISOString(),
      status: "active",
      stages: Object.fromEntries(org.pipeline.map((s) => [s.stage, { status: "pending" as const, attempts: 0 }])),
    }
    await write(projectDir, run)
    return run
  }

  export async function read(projectDir: string, runID: string): Promise<Run> {
    const file = stateFile(projectDir, runID)
    const text = await Bun.file(file)
      .text()
      .catch(() => {
        throw new Error(`Unknown org run "${runID}": ${file} not found`)
      })
    return Run.parse(JSON.parse(text))
  }

  export async function update(projectDir: string, runID: string, fn: (run: Run) => void): Promise<Run> {
    const run = await read(projectDir, runID)
    fn(run)
    await write(projectDir, run)
    return run
  }

  export async function list(projectDir: string): Promise<string[]> {
    const entries = await readdir(runsDir(projectDir)).catch(() => [] as string[])
    return entries.sort().reverse()
  }

  async function write(projectDir: string, run: Run): Promise<void> {
    const dir = runDir(projectDir, run.runID)
    await mkdir(dir, { recursive: true })
    const target = stateFile(projectDir, run.runID)
    const tmp = `${target}.tmp`
    await Bun.write(tmp, JSON.stringify(run, null, 2))
    await rename(tmp, target)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/opencode && bun test test/kilocode/organization/state.test.ts
```
Expected: all pass (the `list` test takes ~1.1s by design).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/state.ts packages/opencode/test/kilocode/organization/state.test.ts
git commit -m "feat(org): file-based run state store with atomic writes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Deliverable artifacts

**Files:**
- Create: `packages/opencode/src/kilocode/organization/artifacts.ts`
- Test: `packages/opencode/test/kilocode/organization/artifacts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/artifacts.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"

describe("OrgArtifacts", () => {
  test("deliverablePath is stable and project-relative displayable", async () => {
    const p = OrgArtifacts.deliverablePath("/proj", "run1", "evaluation")
    expect(p).toBe(path.join("/proj", ".kilo", "org", "runs", "run1", "deliverables", "evaluation.md"))
  })

  test("validate fails when missing", async () => {
    await using tmp = await tmpdir()
    const result = await OrgArtifacts.validate(tmp.path, "run1", "evaluation")
    expect(result.ok).toBe(false)
  })

  test("validate fails when too short", async () => {
    await using tmp = await tmpdir()
    const file = OrgArtifacts.deliverablePath(tmp.path, "run1", "evaluation")
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "short")
    const result = await OrgArtifacts.validate(tmp.path, "run1", "evaluation")
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("short")
  })

  test("validate passes a real deliverable", async () => {
    await using tmp = await tmpdir()
    const file = OrgArtifacts.deliverablePath(tmp.path, "run1", "evaluation")
    await mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "# Evaluation Report\n\n" + "Market looks viable because ".repeat(10))
    const result = await OrgArtifacts.validate(tmp.path, "run1", "evaluation")
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/artifacts.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/kilocode/organization/artifacts.ts
// kilocode_change - new file
import path from "path"
import { OrgState } from "./state"

export namespace OrgArtifacts {
  export const MIN_LENGTH = 50

  export function deliverablesDir(projectDir: string, runID: string): string {
    return path.join(OrgState.runDir(projectDir, runID), "deliverables")
  }

  export function deliverablePath(projectDir: string, runID: string, stage: string): string {
    return path.join(deliverablesDir(projectDir, runID), `${stage}.md`)
  }

  export type Validation = { ok: true } | { ok: false; reason: string }

  export async function validate(projectDir: string, runID: string, stage: string): Promise<Validation> {
    const file = deliverablePath(projectDir, runID, stage)
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined)
    if (text === undefined) return { ok: false, reason: `deliverable not found at ${file}` }
    if (text.trim().length < MIN_LENGTH) {
      return { ok: false, reason: `deliverable at ${file} is too short (${text.trim().length} chars, need >= ${MIN_LENGTH})` }
    }
    return { ok: true }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/opencode && bun test test/kilocode/organization/artifacts.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/artifacts.ts packages/opencode/test/kilocode/organization/artifacts.test.ts
git commit -m "feat(org): deliverable artifact paths and validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Stage prompt builder

**Files:**
- Create: `packages/opencode/src/kilocode/organization/prompts.ts`
- Test: `packages/opencode/test/kilocode/organization/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/prompts.test.ts
import { describe, test, expect } from "bun:test"
import { OrgPrompts } from "../../../src/kilocode/organization/prompts"

describe("OrgPrompts.stagePrompt", () => {
  const input = {
    stage: "frontend",
    idea: "a habit tracker for sailors",
    deliverablePath: "/proj/.kilo/org/runs/r1/deliverables/frontend.md",
    workers: ["swiftui-dev-1", "swiftui-dev-2"],
    shared: ["apple-docs"],
    priorDeliverables: [
      { stage: "planning", path: "/proj/.kilo/org/runs/r1/deliverables/planning.md" },
      { stage: "ux", path: "/proj/.kilo/org/runs/r1/deliverables/ux.md" },
    ],
  }

  test("contains the protocol essentials", () => {
    const prompt = OrgPrompts.stagePrompt(input)
    expect(prompt).toContain("frontend")
    expect(prompt).toContain(input.deliverablePath)
    expect(prompt).toContain("swiftui-dev-1")
    expect(prompt).toContain("apple-docs")
    expect(prompt).toContain("READY")
    expect(prompt).toContain("BLOCKED")
    for (const prior of input.priorDeliverables) expect(prompt).toContain(prior.path)
  })

  test("includes a revise note when present", () => {
    const prompt = OrgPrompts.stagePrompt({ ...input, reviseNote: "add dark mode screens" })
    expect(prompt).toContain("REVISION REQUESTED")
    expect(prompt).toContain("add dark mode screens")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/prompts.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/kilocode/organization/prompts.ts
// kilocode_change - new file

export namespace OrgPrompts {
  export interface StageInput {
    stage: string
    idea: string
    deliverablePath: string
    workers: string[]
    shared: string[]
    priorDeliverables: Array<{ stage: string; path: string }>
    reviseNote?: string
  }

  /** The task prompt the CEO passes verbatim to a department chief. */
  export function stagePrompt(input: StageInput): string {
    const priors = input.priorDeliverables.length
      ? input.priorDeliverables.map((p) => `- ${p.stage}: ${p.path}`).join("\n")
      : "- (none — you are the first stage)"
    const revise = input.reviseNote
      ? `\n## REVISION REQUESTED\nThe user reviewed your previous deliverable and asks:\n${input.reviseNote}\nUpdate the deliverable accordingly.\n`
      : ""
    return `You are running the "${input.stage}" stage of an organization pipeline.

## App idea
${input.idea}

## Prior deliverables (read these first with the read tool)
${priors}
${revise}
## Your team
Delegate concrete work to your workers via the task tool (you may run independent
tasks in parallel with background=true when available): ${input.workers.join(", ")}.
For Apple platform/API/HIG questions consult: ${input.shared.join(", ") || "(none)"}.
Do not do the workers' work yourself; decompose, delegate, verify, integrate.

## Deliverable (mandatory)
Write your department's deliverable to exactly this file:
${input.deliverablePath}
It must be substantial markdown: decisions, produced outputs, file paths of any
code you had written, and open risks.

## Completion protocol
When the deliverable is written and verified, end your final message with the
single word: READY
If you cannot complete the stage, end with: BLOCKED: <one-line reason>`
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/opencode && bun test test/kilocode/organization/prompts.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/prompts.ts packages/opencode/test/kilocode/organization/prompts.test.ts
git commit -m "feat(org): chief stage prompt builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Pipeline runner (state machine)

**Files:**
- Create: `packages/opencode/src/kilocode/organization/runner.ts`
- Test: `packages/opencode/test/kilocode/organization/runner.test.ts`

The runner is pure orchestration logic over schema+state+artifacts+prompts. `advance` is idempotent: calling it repeatedly converges. Cost lookup is injected (`costOf`) so tests need no session DB.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/opencode/test/kilocode/organization/runner.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "../../fixture/fixture"
import { OrgRunner } from "../../../src/kilocode/organization/runner"
import { OrgSchema } from "../../../src/kilocode/organization/schema"
import { OrgArtifacts } from "../../../src/kilocode/organization/artifacts"
import { OrgState } from "../../../src/kilocode/organization/state"

const ORG = OrgSchema.parse({
  ceo: "ceo",
  departments: {
    evaluation: { chief: "eval-chief", workers: ["market-research"] },
    planning: { chief: "planning-chief", workers: ["architect"] },
  },
  shared: ["apple-docs"],
  pipeline: [{ stage: "evaluation", gate: "human", haltOn: "no-go" }, { stage: "planning" }],
})

async function writeDeliverable(dir: string, runID: string, stage: string) {
  const file = OrgArtifacts.deliverablePath(dir, runID, stage)
  await mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, `# ${stage} deliverable\n\n` + "content ".repeat(20))
}

const deps = { costOf: async () => 0.42 }

describe("OrgRunner full flows", () => {
  test("no-go at gate 1 halts the run cleanly", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea one")

    // 1st advance: instructs the evaluation stage
    const first = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(first.kind).toBe("instruct")
    if (first.kind !== "instruct") throw new Error("unreachable")
    expect(first.stage).toBe("evaluation")
    expect(first.chief).toBe("eval-chief")
    expect(first.taskPrompt).toContain("evaluation")

    // chief "ran" and wrote the deliverable; CEO reports the task session id
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    const second = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(second.kind).toBe("gate")
    if (second.kind !== "gate") throw new Error("unreachable")
    expect(second.stage).toBe("evaluation")

    // repeated advance while awaiting approval keeps returning the gate (idempotent)
    const again = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(again.kind).toBe("gate")

    const decided = await OrgRunner.decide(tmp.path, ORG, run.runID, "no-go", "market too small")
    expect(decided.status).toBe("halted")

    const after = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(after.kind).toBe("halted")

    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.stages["evaluation"].cost).toBe(0.42)
    expect(state.stages["evaluation"].taskID).toBe("ses_eval")
    expect(state.stages["planning"].status).toBe("pending")
  })

  test("approve -> second stage -> done", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea two")

    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "approve")

    const third = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(third.kind).toBe("instruct")
    if (third.kind !== "instruct") throw new Error("unreachable")
    expect(third.stage).toBe("planning")
    // prior deliverable paths are threaded into the next stage prompt
    expect(third.taskPrompt).toContain(OrgArtifacts.deliverablePath(tmp.path, run.runID, "evaluation"))

    await writeDeliverable(tmp.path, run.runID, "planning")
    const done = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_plan" })
    expect(done.kind).toBe("done")
    const state = await OrgState.read(tmp.path, run.runID)
    expect(state.status).toBe("completed")
  })

  test("incomplete deliverable returns incomplete with resume id", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea three")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    const result = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    expect(result.kind).toBe("incomplete")
    if (result.kind !== "incomplete") throw new Error("unreachable")
    expect(result.resumeTaskID).toBe("ses_eval")
    expect(result.reason).toContain("deliverable")
  })

  test("revise sends the stage back to running with the note", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea four")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    await writeDeliverable(tmp.path, run.runID, "evaluation")
    await OrgRunner.advance(deps, tmp.path, ORG, run.runID, { taskID: "ses_eval" })
    await OrgRunner.decide(tmp.path, ORG, run.runID, "revise", "check EU market too")

    const redo = await OrgRunner.advance(deps, tmp.path, ORG, run.runID, {})
    expect(redo.kind).toBe("instruct")
    if (redo.kind !== "instruct") throw new Error("unreachable")
    expect(redo.stage).toBe("evaluation")
    expect(redo.resumeTaskID).toBe("ses_eval")
    expect(redo.taskPrompt).toContain("check EU market too")
  })

  test("decide outside a gate fails", async () => {
    await using tmp = await tmpdir()
    const run = await OrgRunner.start(tmp.path, ORG, "idea five")
    await expect(OrgRunner.decide(tmp.path, ORG, run.runID, "approve")).rejects.toThrow(/no stage awaiting/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/opencode && bun test test/kilocode/organization/runner.test.ts
```
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/opencode/src/kilocode/organization/runner.ts
// kilocode_change - new file
import { OrgSchema } from "./schema"
import { OrgState } from "./state"
import { OrgArtifacts } from "./artifacts"
import { OrgPrompts } from "./prompts"

export namespace OrgRunner {
  export interface Deps {
    /** Look up accumulated cost of a chief's task session. Injected; DB-backed in tools.ts. */
    costOf: (taskID: string) => Promise<number | undefined>
  }

  export type Advance =
    | {
        kind: "instruct"
        stage: string
        chief: string
        taskPrompt: string
        /** Present when the same chief session should be resumed (revise / retry). */
        resumeTaskID?: string
      }
    | { kind: "gate"; stage: string; deliverablePath: string }
    | { kind: "incomplete"; stage: string; reason: string; resumeTaskID?: string }
    | { kind: "halted"; reason: string }
    | { kind: "done" }

  export function start(projectDir: string, org: OrgSchema.Organization, idea: string) {
    return OrgState.create(projectDir, org, idea)
  }

  function priorDeliverables(projectDir: string, org: OrgSchema.Organization, run: OrgState.Run, upto: string) {
    const priors: Array<{ stage: string; path: string }> = []
    for (const { stage } of org.pipeline) {
      if (stage === upto) break
      if (run.stages[stage]?.status === "completed") {
        priors.push({ stage, path: OrgArtifacts.deliverablePath(projectDir, run.runID, stage) })
      }
    }
    return priors
  }

  function instruct(
    projectDir: string,
    org: OrgSchema.Organization,
    run: OrgState.Run,
    stage: string,
    opts: { reviseNote?: string; resumeTaskID?: string } = {},
  ): Advance {
    const dept = org.departments[stage]
    return {
      kind: "instruct",
      stage,
      chief: dept.chief,
      resumeTaskID: opts.resumeTaskID,
      taskPrompt: OrgPrompts.stagePrompt({
        stage,
        idea: run.idea,
        deliverablePath: OrgArtifacts.deliverablePath(projectDir, run.runID, stage),
        workers: dept.workers,
        shared: org.shared,
        priorDeliverables: priorDeliverables(projectDir, org, run, stage),
        reviseNote: opts.reviseNote,
      }),
    }
  }

  export async function advance(
    deps: Deps,
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    input: { taskID?: string },
  ): Promise<Advance> {
    let run = await OrgState.read(projectDir, runID)
    if (run.status === "halted") return { kind: "halted", reason: run.haltReason ?? "run halted" }
    if (run.status === "completed") return { kind: "done" }

    // 1. A stage awaiting approval blocks everything until org_decision.
    const awaiting = org.pipeline.find(({ stage }) => run.stages[stage].status === "awaiting_approval")
    if (awaiting) {
      return {
        kind: "gate",
        stage: awaiting.stage,
        deliverablePath: OrgArtifacts.deliverablePath(projectDir, runID, awaiting.stage),
      }
    }

    // 2. A running stage: record taskID, then validate its deliverable.
    const running = org.pipeline.find(({ stage }) => run.stages[stage].status === "running")
    if (running) {
      const stage = running.stage
      if (input.taskID) {
        run = await OrgState.update(projectDir, runID, (s) => {
          s.stages[stage].taskID = input.taskID
        })
      }
      const record = run.stages[stage]
      // A revise decision pending on a running stage means: re-instruct the chief.
      if (record.decision === "revise") {
        const note = record.decisionNote
        const resume = record.taskID
        await OrgState.update(projectDir, runID, (s) => {
          s.stages[stage].decision = undefined
          s.stages[stage].decisionNote = undefined
          s.stages[stage].attempts += 1
        })
        return instruct(projectDir, org, run, stage, { reviseNote: note, resumeTaskID: resume })
      }
      const validation = await OrgArtifacts.validate(projectDir, runID, stage)
      if (!validation.ok) {
        return { kind: "incomplete", stage, reason: validation.reason, resumeTaskID: record.taskID }
      }
      const cost = record.taskID ? await deps.costOf(record.taskID) : undefined
      run = await OrgState.update(projectDir, runID, (s) => {
        s.stages[stage].completedAt = new Date().toISOString()
        if (cost !== undefined) s.stages[stage].cost = cost
        s.stages[stage].status = running.gate === "human" ? "awaiting_approval" : "completed"
      })
      if (running.gate === "human") {
        return { kind: "gate", stage, deliverablePath: OrgArtifacts.deliverablePath(projectDir, runID, stage) }
      }
    }

    // 3. Start the next pending stage.
    const next = org.pipeline.find(({ stage }) => run.stages[stage].status === "pending")
    if (next) {
      run = await OrgState.update(projectDir, runID, (s) => {
        s.stages[next.stage].status = "running"
        s.stages[next.stage].startedAt = new Date().toISOString()
        s.stages[next.stage].attempts += 1
      })
      return instruct(projectDir, org, run, next.stage)
    }

    // 4. Nothing pending, running, or gated: the run is complete.
    await OrgState.update(projectDir, runID, (s) => {
      s.status = "completed"
    })
    return { kind: "done" }
  }

  export async function decide(
    projectDir: string,
    org: OrgSchema.Organization,
    runID: string,
    decision: "approve" | "no-go" | "revise",
    note?: string,
  ): Promise<OrgState.Run> {
    const run = await OrgState.read(projectDir, runID)
    const gated = org.pipeline.find(({ stage }) => run.stages[stage].status === "awaiting_approval")
    if (!gated) throw new Error(`Cannot record decision "${decision}": no stage awaiting approval in run ${runID}`)
    return OrgState.update(projectDir, runID, (s) => {
      const record = s.stages[gated.stage]
      record.decision = decision
      record.decisionNote = note
      if (decision === "approve") {
        record.status = "completed"
      } else if (decision === "no-go") {
        record.status = "completed"
        s.status = "halted"
        s.haltReason = `no-go at ${gated.stage}${note ? `: ${note}` : ""}`
      } else {
        record.status = "running"
      }
    })
  }

  export async function status(projectDir: string, org: OrgSchema.Organization, runID: string) {
    const run = await OrgState.read(projectDir, runID)
    const totalCost = Object.values(run.stages).reduce((sum, s) => sum + (s.cost ?? 0), 0)
    return { run, totalCost, pipeline: org.pipeline.map(({ stage, gate }) => ({ stage, gate, ...run.stages[stage] })) }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/opencode && bun test test/kilocode/organization/runner.test.ts
```
Expected: all pass. If the revise flow fails, check the interplay: `decide(revise)` sets status back to `running` with `decision: "revise"` persisted; the next `advance` hits branch 2 and re-instructs.

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/kilocode/organization/runner.ts packages/opencode/test/kilocode/organization/runner.test.ts
git commit -m "feat(org): deterministic pipeline runner with gates, revise, no-go, resume

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: `org_*` tools + registry wiring

**Files:**
- Create: `packages/opencode/src/kilocode/organization/tools.ts`
- Modify: `packages/opencode/src/kilocode/tool/registry.ts`
- Modify: call sites of `KiloToolRegistry.infos/build/extra` (found via typecheck)

Tools are thin Effect adapters over the runner. Execute-time guard: only the configured CEO agent may call them (they are also hidden from subagents via `available`).

- [ ] **Step 1: Verify the InstanceState directory field name**

```bash
cd packages/opencode && grep -n "directory\|worktree" src/kilocode/plan-file.ts | head -10
grep -rn "InstanceState.context" src/kilocode/tool/*.ts | head -5
```
Confirm which field of the instance context object carries the project directory (expected: `directory`; if it is `worktree` or nested, adjust `projectDir` below accordingly).

- [ ] **Step 2: Write the implementation** (tools are exercised through the template integration test in Task 15 and through typecheck; the runner logic underneath is already unit-tested)

```typescript
// packages/opencode/src/kilocode/organization/tools.ts
// kilocode_change - new file
import { Effect, Schema } from "effect"
import * as Tool from "@/tool/tool"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { KiloCostPropagation } from "@/kilocode/session/cost-propagation"
import { OrgSchema } from "./schema"
import { OrgRunner } from "./runner"
import { OrgState } from "./state"

const load = (projectDir: string) => Effect.tryPromise(() => OrgSchema.loadOrganization(projectDir))

const guardCeo = (org: OrgSchema.Organization, agent: string) =>
  agent === org.ceo
    ? Effect.void
    : Effect.fail(new Error(`org tools are reserved for the CEO agent "${org.ceo}" (called by "${agent}")`))

function projectDir(instance: { directory: string }) {
  return instance.directory
}

function result(title: string, body: unknown) {
  return { title, metadata: {}, output: typeof body === "string" ? body : JSON.stringify(body, null, 2) }
}

export const OrgStartTool = Tool.define(
  "org_start",
  Effect.gen(function* () {
    return {
      description:
        "Start a new organization pipeline run from an app idea. Returns the run_id. Then call org_advance to get the first stage instruction.",
      parameters: Schema.Struct({
        idea: Schema.String.annotate({ description: "The app idea, verbatim from the user" }),
      }),
      execute: (params: { idea: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = projectDir(instance)
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const run = yield* Effect.tryPromise(() => OrgRunner.start(dir, org, params.idea))
          return result(`org run ${run.runID}`, {
            run_id: run.runID,
            pipeline: org.pipeline,
            next: "call org_advance with this run_id",
          })
        }).pipe(Effect.orDie),
    }
  }),
)

export const OrgAdvanceTool = Tool.define(
  "org_advance",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return {
      description:
        "Advance the organization pipeline. Validates the current stage's deliverable, enforces gates, and returns the next action: an exact task-tool call to run a department chief, a human gate to resolve via org_decision, or done/halted. Pass task_id after a chief task finishes so cost and resume tracking work.",
      parameters: Schema.Struct({
        run_id: Schema.String,
        task_id: Schema.optional(Schema.String).annotate({
          description: "The task session id of the chief task you just ran for the current stage",
        }),
      }),
      execute: (params: { run_id: string; task_id?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = projectDir(instance)
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const deps: OrgRunner.Deps = {
            costOf: (taskID) =>
              Effect.runPromise(
                KiloCostPropagation.childCost(sessions, SessionID.make(taskID)).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                ),
              ),
          }
          const advance = yield* Effect.tryPromise(() =>
            OrgRunner.advance(deps, dir, org, params.run_id, { taskID: params.task_id }),
          )
          switch (advance.kind) {
            case "instruct":
              return result(`stage: ${advance.stage}`, {
                action: "run_task",
                stage: advance.stage,
                task_call: {
                  subagent_type: advance.chief,
                  description: `${advance.stage} stage`,
                  prompt: advance.taskPrompt,
                  ...(advance.resumeTaskID ? { task_id: advance.resumeTaskID } : {}),
                },
                then: "when the chief returns READY, call org_advance again with task_id set to the task session id",
              })
            case "gate":
              return result(`gate: ${advance.stage}`, {
                action: "human_gate",
                stage: advance.stage,
                deliverable: advance.deliverablePath,
                instructions:
                  "Read the deliverable, summarize it for the user in their language, ask for a decision with the question tool (approve / no-go / revise with a note), then call org_decision.",
              })
            case "incomplete":
              return result(`incomplete: ${advance.stage}`, {
                action: "resume_chief",
                stage: advance.stage,
                reason: advance.reason,
                ...(advance.resumeTaskID ? { resume_task_id: advance.resumeTaskID } : {}),
              })
            case "halted":
              return result("halted", { action: "halted", reason: advance.reason })
            case "done":
              return result("done", { action: "done", note: "pipeline complete; present the final package to the user" })
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const OrgDecisionTool = Tool.define(
  "org_decision",
  Effect.gen(function* () {
    return {
      description: "Record the user's gate decision for the stage awaiting approval (approve / no-go / revise).",
      parameters: Schema.Struct({
        run_id: Schema.String,
        decision: Schema.Literals(["approve", "no-go", "revise"]),
        note: Schema.optional(Schema.String).annotate({ description: "Required for revise: what the user wants changed" }),
      }),
      execute: (params: { run_id: string; decision: "approve" | "no-go" | "revise"; note?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = projectDir(instance)
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          const run = yield* Effect.tryPromise(() =>
            OrgRunner.decide(dir, org, params.run_id, params.decision, params.note),
          )
          return result(`decision: ${params.decision}`, { status: run.status, next: "call org_advance" })
        }).pipe(Effect.orDie),
    }
  }),
)

export const OrgStatusTool = Tool.define(
  "org_status",
  Effect.gen(function* () {
    return {
      description:
        "Show the organization chart and validation (no run_id), or the state and cost breakdown of a run (with run_id). Use for dry-run inspection of the org config.",
      parameters: Schema.Struct({
        run_id: Schema.optional(Schema.String),
      }),
      execute: (params: { run_id?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const dir = projectDir(instance)
          const org = yield* load(dir)
          yield* guardCeo(org, ctx.agent)
          if (!params.run_id) {
            const runs = yield* Effect.tryPromise(() => OrgState.list(dir))
            return result("organization", { organization: org, runs })
          }
          const status = yield* Effect.tryPromise(() => OrgRunner.status(dir, org, params.run_id!))
          return result(`run ${params.run_id}`, status)
        }).pipe(Effect.orDie),
    }
  }),
)
```

- [ ] **Step 3: Wire into `packages/opencode/src/kilocode/tool/registry.ts`**

3a. Import at the top:
```typescript
import { OrgStartTool, OrgAdvanceTool, OrgDecisionTool, OrgStatusTool } from "@/kilocode/organization/tools"
```

3b. In `infos()` (~line 55): add after `const terminal = yield* InteractiveTerminalTool`:
```typescript
      const orgStart = yield* OrgStartTool
      const orgAdvance = yield* OrgAdvanceTool
      const orgDecision = yield* OrgDecisionTool
      const orgStatus = yield* OrgStatusTool
```
and add `orgStart, orgAdvance, orgDecision, orgStatus` to BOTH returned objects in `infos()`.

3c. In `build()` (~line 78): add the four fields to the `tools` parameter type (each `Tool.Info`), and inside the `Effect.all({...})` base block add:
```typescript
        orgStart: Tool.init(tools.orgStart),
        orgAdvance: Tool.init(tools.orgAdvance),
        orgDecision: Tool.init(tools.orgDecision),
        orgStatus: Tool.init(tools.orgStatus),
```

3d. In `extra()` (~line 165): add the four fields to the parameter type (each `Tool.Def`), and append to the returned array:
```typescript
      tools.orgStart,
      tools.orgAdvance,
      tools.orgDecision,
      tools.orgStatus,
```

3e. In `available()` (~line 159): hide org tools from subagents:
```typescript
  export function available(tool: Tool.Def, agent: Agent.Info) {
    if (tool.id.startsWith("org_")) return agent.mode === "primary"
    if (tool.id !== "interactive_terminal") return true
    return agent.mode === "primary"
  }
```

- [ ] **Step 4: Typecheck and fix the infos/build/extra call sites**

```bash
cd /Users/mertcanbasak/Now/northstar && bun turbo typecheck 2>&1 | head -40
```
The compiler will point at every call site that destructures/passes the registry tool sets (expected in `packages/opencode/src/session/tools.ts` and/or a kilocode bootstrap module). At each, thread the four new tools exactly the way the neighboring `image`/`process` tools are threaded — no conditional logic. Re-run typecheck until clean.

- [ ] **Step 5: Run the full kilocode organization suite**

```bash
cd packages/opencode && bun test test/kilocode/organization/
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A packages/opencode/src
git commit -m "feat(org): org_start/org_advance/org_decision/org_status tools, registry wiring

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Org template — organization.jsonc, CEO, evaluation department, /build-app command

**Files:**
- Create: `org-template/organization.jsonc`
- Create: `org-template/agents/ceo.md`, `org-template/agents/eval-chief.md`, `org-template/agents/market-research.md`, `org-template/agents/competitor-analysis.md`, `org-template/agents/feasibility.md`, `org-template/agents/apple-docs.md`
- Create: `org-template/command/build-app.md`

Conventions used in ALL template agent files:
- Prompts in English (model performance); chiefs/CEO are instructed to report to the user in the user's language.
- Chiefs: frontier model, `subordinates` (workers + `apple-docs`), edit confined to `**/.kilo/org/**`, no bash/web.
- Research/marketing workers: web on, edit/bash off. Dev workers: edit on + narrow bash allowlist. Ordering inside `permission.bash`: `"*": deny` FIRST (last-match-wins).

- [ ] **Step 1: Write `org-template/organization.jsonc`**

```jsonc
// Organization chart + pipeline for the app-building organization.
// Copy this whole template into your app project: cp -r org-template/. <project>/.kilo/
{
  "ceo": "ceo",
  "departments": {
    "evaluation": { "chief": "eval-chief", "workers": ["market-research", "competitor-analysis", "feasibility"] },
    "planning":   { "chief": "planning-chief", "workers": ["product-spec", "architect"] },
    "ux":         { "chief": "ux-chief", "workers": ["ux-designer"] },
    "backend":    { "chief": "backend-chief", "workers": ["data-layer-dev"] },
    "frontend":   { "chief": "frontend-chief", "workers": ["swiftui-dev-1", "swiftui-dev-2"] },
    "testing":    { "chief": "test-chief", "workers": ["unit-tester", "ui-tester"] },
    "debugging":  { "chief": "debug-chief", "workers": ["debugger"] },
    "marketing":  { "chief": "marketing-chief", "workers": ["aso-specialist", "copywriter", "pricing-analyst", "preview-designer"] }
  },
  "shared": ["apple-docs"],
  "pipeline": [
    { "stage": "evaluation", "gate": "human", "haltOn": "no-go" },
    { "stage": "planning" },
    { "stage": "ux" },
    { "stage": "backend" },
    { "stage": "frontend" },
    { "stage": "testing" },
    { "stage": "debugging" },
    { "stage": "marketing", "gate": "human" }
  ]
}
```

- [ ] **Step 2: Write `org-template/agents/ceo.md`**

```markdown
---
description: Organization CEO — runs the idea-to-App-Store pipeline, the only agent that talks to the user
mode: primary
model: anthropic/claude-fable-5
subordinates:
  [
    eval-chief,
    planning-chief,
    ux-chief,
    backend-chief,
    frontend-chief,
    test-chief,
    debug-chief,
    marketing-chief,
  ]
permission:
  edit: deny
  bash: deny
  webfetch: deny
  websearch: deny
  question: allow
---

# Role

You are the CEO of an app-development organization. You take an app idea from the
user and drive it through the pipeline using the org tools. You never write code,
never research, never design — your chiefs do. You orchestrate and communicate.

# Protocol (follow exactly)

1. When the user gives an idea, call `org_start` with it, then `org_advance`.
2. When `org_advance` returns `action: run_task`, call the `task` tool with EXACTLY
   the `task_call` parameters it gives you (subagent_type, description, prompt, and
   task_id if present). Do not rewrite the prompt.
3. When the chief's task returns, call `org_advance` again with `task_id` set to the
   id from the task result (`<task id="...">`).
4. When `org_advance` returns `action: human_gate`: read the deliverable file,
   summarize it faithfully for the user in the user's language (include cumulative
   cost from `org_status`), ask the user to decide via the `question` tool
   (approve / no-go / revise+note), then call `org_decision` and continue with
   `org_advance`.
5. When it returns `action: resume_chief`, resume the chief once via the task tool
   (task_id = resume_task_id, prompt = the reason plus "complete the deliverable").
   If it fails again, stop and report to the user honestly.
6. On `action: done`, present the final package: what was built, where the
   deliverables are, and the marketing package summary.

# Don't

- Never skip `org_advance` or reorder stages yourself; the runner owns the order.
- Never invent results. If a stage failed, say so and show why.
- Never call a chief that org_advance did not instruct you to call.
```

- [ ] **Step 3: Write the evaluation department**

`org-template/agents/eval-chief.md`:
```markdown
---
description: Evaluation department chief — market research, competition, feasibility; produces the go/no-go report
mode: subagent
model: anthropic/claude-fable-5
subordinates: [market-research, competitor-analysis, feasibility, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role

You run the evaluation department. Given an app idea, you produce an evidence-based
evaluation report with a clear go / no-go recommendation.

# Do

- Split the work: market demand + audience (market-research), competing App Store
  apps and their gaps (competitor-analysis), technical/economic viability
  (feasibility). Run them via the task tool and integrate their findings.
- Demand sources/evidence from workers; discard unsupported claims.
- Structure the deliverable: Market, Competition, Demand/Supply constraints,
  Suggested feature set, Risks, Verdict (GO or NO-GO with reasoning).

# Don't

- Don't do the research yourself; you have no web access — your workers do.
- Don't soften a weak idea. A justified NO-GO is a successful outcome.
- Don't exceed the deliverable protocol given in your task prompt (READY/BLOCKED).
```

`org-template/agents/market-research.md`:
```markdown
---
description: Market research worker — demand, audience, willingness to pay (web-enabled)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role

You research market demand for a proposed iOS app: audience size, existing demand
signals (search trends, forums, reviews of adjacent apps), willingness to pay.

# Do

- Search broadly, then verify: prefer primary sources; cite URLs for every claim.
- Quantify where possible (ranges are fine; state confidence).
- Return a compact findings report as your final message text.

# Don't

- Don't fabricate numbers or cite sources you did not open.
- Don't drift into competitor feature analysis — a sibling worker owns that.
```

`org-template/agents/competitor-analysis.md`:
```markdown
---
description: Competitor analysis worker — App Store competitors, their gaps and pricing (web-enabled)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role

You map the competitive landscape on the App Store for a proposed app idea.

# Do

- Identify the top direct and indirect competitors; for each: pricing model,
  standout features, rating volume, and the complaints in their recent reviews.
- Name the exploitable gap (or state clearly that there is none).
- Cite App Store links / sources for every competitor.

# Don't

- Don't evaluate market size — a sibling worker owns that.
- Don't list more than ~8 competitors; depth beats breadth.
```

`org-template/agents/feasibility.md`:
```markdown
---
description: Feasibility worker — technical and economic viability of the idea (web-enabled)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role

You assess whether a small team can realistically build and ship the proposed iOS
app: required APIs/entitlements, App Store review risks, on-device vs server needs,
rough effort, and running costs.

# Do

- Check Apple API availability and App Review Guidelines exposure for the core
  features; flag anything requiring special entitlements.
- Estimate a coarse build effort (S/M/L) and any recurring infrastructure cost.
- State the single biggest feasibility risk explicitly.

# Don't

- Don't assess demand or competition — sibling workers own those.
```

`org-template/agents/apple-docs.md`:
```markdown
---
description: Apple developer documentation specialist — read-only consultant for APIs, HIG, and App Store rules
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch:
    "*": deny
    "https://developer.apple.com/*": allow
    "https://developer.apple.com/design/*": allow
---

# Role

You answer precise questions about Apple platform APIs, the Human Interface
Guidelines, and App Store submission requirements, grounded in developer.apple.com.

# Do

- Answer only what was asked; quote or link the exact doc section.
- Say "not documented" when it isn't — never guess API behavior.

# Don't

- Don't write application code; you are a reference desk, not a developer.
```

- [ ] **Step 4: Write `org-template/command/build-app.md`**

```markdown
---
description: Start (or resume) an organization run that takes an app idea to an App Store-ready package
agent: ceo
---

The user wants to run the app-building organization.

Input: $ARGUMENTS

- If the input starts with `--resume <run-id>`: call org_status for that run, then
  continue the protocol with org_advance.
- If the input starts with `--status`: call org_status (with the run id if given)
  and report; do not advance anything.
- Otherwise treat the entire input as the app idea and follow your protocol from
  step 1 (org_start).
```

- [ ] **Step 5: Sanity-parse the template so far**

```bash
cd packages/opencode && bun -e '
const { OrgSchema } = await import("./src/kilocode/organization/schema.ts")
const { parse } = await import("jsonc-parser")
const text = await Bun.file("../../org-template/organization.jsonc").text()
const org = OrgSchema.parse(parse(text))
console.log("validate:", OrgSchema.validate(org))
'
```
Expected: `validate: []`.

- [ ] **Step 6: Commit**

```bash
git add org-template/
git commit -m "feat(org-template): organization chart, CEO, evaluation department, /build-app command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Org template — planning, UX, backend, frontend departments

**Files:**
- Create: `org-template/agents/planning-chief.md`, `product-spec.md`, `architect.md`, `ux-chief.md`, `ux-designer.md`, `backend-chief.md`, `data-layer-dev.md`, `frontend-chief.md`, `swiftui-dev-1.md`, `swiftui-dev-2.md`

All chiefs follow the eval-chief pattern (frontier model, subordinates = workers + apple-docs, edit only under `**/.kilo/org/**`, no bash/web). Dev workers get source edit rights and a narrow bash allowlist.

- [ ] **Step 1: Write the four chiefs**

`org-template/agents/planning-chief.md`:
```markdown
---
description: Planning department chief — turns the approved idea + evaluation into a PRD and technical plan
mode: subagent
model: anthropic/claude-fable-5
subordinates: [product-spec, architect, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run planning. Input: the idea and the evaluation report. Output: a PRD
(features, user stories, MVP cut) and a technical plan (architecture, data model,
screen list, milestones) that downstream departments will follow literally.

# Do
- product-spec writes the PRD; architect writes the technical plan; you reconcile
  conflicts and cut scope aggressively (MVP first).
- Every feature in the PRD must trace back to evidence in the evaluation report.

# Don't
- Don't design UI (UX department) or write code (dev departments).
- Don't plan features the evaluation flagged as risks without marking them deferred.
```

`org-template/agents/ux-chief.md`:
```markdown
---
description: UX department chief — screen map, flows, and HIG-compliant design language
mode: subagent
model: anthropic/claude-fable-5
subordinates: [ux-designer, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run UX. Input: PRD + technical plan. Output: a screen map with navigation
flows, per-screen content/interaction specs, and a design language (colors, type,
spacing, SF Symbols) that SwiftUI developers can implement without guessing.

# Do
- Verify every pattern against the HIG via apple-docs before committing to it.
- Specify empty/loading/error states for every screen.

# Don't
- Don't produce code; produce specs precise enough to code from.
```

`org-template/agents/backend-chief.md`:
```markdown
---
description: Backend department chief — data model, persistence, and services layer
mode: subagent
model: anthropic/claude-fable-5
subordinates: [data-layer-dev, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run the backend/data department for a native iOS app. Input: PRD, technical
plan, UX spec. Output: implemented data layer (SwiftData/CloudKit or as the plan
dictates), services, and a deliverable documenting the model and public APIs the
frontend will call.

# Do
- Delegate implementation to data-layer-dev in reviewable slices; verify each
  compiles (worker runs the builds, you read the results).
- Keep the public surface minimal and documented in the deliverable.

# Don't
- Don't let scope creep past the technical plan; escalate BLOCKED instead.
```

`org-template/agents/frontend-chief.md`:
```markdown
---
description: Frontend department chief — SwiftUI implementation of the UX spec
mode: subagent
model: anthropic/claude-fable-5
subordinates: [swiftui-dev-1, swiftui-dev-2, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run the SwiftUI frontend department. Input: UX spec + backend deliverable.
Output: implemented screens wired to the data layer, matching the UX spec.

# Do
- Split screens between swiftui-dev-1 and swiftui-dev-2 by feature area; run
  independent screens in parallel (background=true) when available.
- Enforce the design language tokens from the UX deliverable; check HIG questions
  with apple-docs.
- Require each worker to prove their code builds before you accept it.

# Don't
- Don't write code yourself; decompose, delegate, review, integrate.
- Don't accept UI that silently diverges from the UX spec — send it back.
```

- [ ] **Step 2: Write the six workers**

`org-template/agents/product-spec.md`:
```markdown
---
description: Product spec worker — writes the PRD (features, user stories, MVP cut)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You write PRDs for iOS apps: problem, target user, features with user stories,
MVP vs later, success metrics. Input arrives in your task prompt (idea +
evaluation findings). Return the full PRD as your final message text.

# Do
- Number features; mark each MVP or vNext; keep stories testable.

# Don't
- Don't invent features with no grounding in the evaluation input.
```

`org-template/agents/architect.md`:
```markdown
---
description: Architecture worker — technical plan, data model, screen inventory, milestones
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You produce the technical plan for a native SwiftUI app from a PRD: app
architecture (e.g. MV + services), data model, persistence choice
(SwiftData/CloudKit/files) with justification, screen inventory, and build order.
Return the plan as your final message text.

# Do
- Prefer boring, Apple-native choices; justify any dependency.

# Don't
- Don't specify UI visuals — UX owns that.
```

`org-template/agents/ux-designer.md`:
```markdown
---
description: UX design worker — screen specs, flows, and design language for SwiftUI
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You design iOS app UX on paper: navigation map, per-screen layout described in
SwiftUI-implementable terms (stacks, lists, toolbars, sheets), interaction and
state specs, and a compact design token set (colors, type ramp, spacing,
SF Symbols). Return specs as your final message text.

# Do
- Follow platform conventions; when in doubt, say which HIG page governs.
- Cover empty, loading, and error states for every screen.

# Don't
- Don't emit Swift code; emit precise specs.
```

`org-template/agents/data-layer-dev.md`:
```markdown
---
description: Data layer developer — SwiftData/CloudKit models, persistence, services (build-verified)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: allow
  bash:
    "*": deny
    "swift build*": allow
    "swift test*": allow
    "xcodebuild*": allow
    "xcrun simctl*": allow
    "git status*": allow
    "git diff*": allow
  webfetch:
    "*": deny
    "https://developer.apple.com/*": allow
  websearch: deny
---

# Role
You implement the data/services layer of a SwiftUI app exactly as the technical
plan specifies: models, persistence, migrations, service protocols.

# Do
- Build after every meaningful change (xcodebuild or swift build) and fix errors
  before reporting; include the passing build command output summary in your report.
- Keep types small and invariants inside the types.

# Don't
- Don't touch view code; frontend owns it.
- Don't add dependencies the plan didn't approve.
```

`org-template/agents/swiftui-dev-1.md`:
```markdown
---
description: SwiftUI developer 1 — implements screens from the UX spec (build-verified)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: allow
  bash:
    "*": deny
    "swift build*": allow
    "swift test*": allow
    "xcodebuild*": allow
    "xcrun simctl*": allow
    "git status*": allow
    "git diff*": allow
  webfetch:
    "*": deny
    "https://developer.apple.com/*": allow
  websearch: deny
---

# Role
You implement SwiftUI screens exactly as the UX spec describes, wired to the data
layer's public services.

# Do
- Match the design tokens (colors/type/spacing) from the UX deliverable.
- Build after every screen; report the build command and result honestly.
- Implement empty/loading/error states — they are part of the spec, not extras.

# Don't
- Don't restyle or "improve" the design; deviations go back to your chief as questions.
- Don't modify the data layer; request changes through your chief.
```

`org-template/agents/swiftui-dev-2.md`:
```markdown
---
description: SwiftUI developer 2 — implements screens from the UX spec (build-verified)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: allow
  bash:
    "*": deny
    "swift build*": allow
    "swift test*": allow
    "xcodebuild*": allow
    "xcrun simctl*": allow
    "git status*": allow
    "git diff*": allow
  webfetch:
    "*": deny
    "https://developer.apple.com/*": allow
  websearch: deny
---

# Role
You implement SwiftUI screens exactly as the UX spec describes, wired to the data
layer's public services.

# Do
- Match the design tokens (colors/type/spacing) from the UX deliverable.
- Build after every screen; report the build command and result honestly.
- Implement empty/loading/error states — they are part of the spec, not extras.

# Don't
- Don't restyle or "improve" the design; deviations go back to your chief as questions.
- Don't modify the data layer; request changes through your chief.
```

- [ ] **Step 3: Commit**

```bash
git add org-template/agents/
git commit -m "feat(org-template): planning, ux, backend, frontend departments

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Org template — testing, debugging, marketing departments + README

**Files:**
- Create: `org-template/agents/test-chief.md`, `unit-tester.md`, `ui-tester.md`, `debug-chief.md`, `debugger.md`, `marketing-chief.md`, `aso-specialist.md`, `copywriter.md`, `pricing-analyst.md`, `preview-designer.md`
- Create: `org-template/README.md`

- [ ] **Step 1: Write the chiefs**

`org-template/agents/test-chief.md`:
```markdown
---
description: Testing department chief — unit and UI test suites over the implemented app
mode: subagent
model: anthropic/claude-fable-5
subordinates: [unit-tester, ui-tester, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run testing. Input: the implemented app + PRD (acceptance criteria live there).
Output: test suites written and executed, with a deliverable reporting coverage of
acceptance criteria and every failure found.

# Do
- unit-tester covers models/services; ui-tester covers critical user flows (XCUITest).
- Every PRD user story must map to at least one test or be explicitly waived in
  the deliverable.
- Report failures as failures. A red suite with an honest report is a valid READY.

# Don't
- Don't fix app code — that is the debugging department's job; document failures precisely instead.
```

`org-template/agents/debug-chief.md`:
```markdown
---
description: Debugging department chief — drives failures from the test report to a green build
mode: subagent
model: anthropic/claude-fable-5
subordinates: [debugger, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run debugging. Input: the testing deliverable (failures) and the codebase.
Output: fixes for every reproducible failure and a deliverable logging root cause
-> fix -> verification for each.

# Do
- One failure per debugger task; require root-cause analysis before any fix.
- Require the full test suite green (or explicitly waived items) before READY.

# Don't
- Don't accept symptom-patches; if the root cause is unclear, the fix is not done.
```

`org-template/agents/marketing-chief.md`:
```markdown
---
description: Marketing department chief — complete App Store listing package
mode: subagent
model: anthropic/claude-fable-5
subordinates: [aso-specialist, copywriter, pricing-analyst, preview-designer, apple-docs]
permission:
  edit:
    "*": deny
    "**/.kilo/org/**": allow
  bash: deny
  webfetch: deny
  websearch: deny
---

# Role
You run marketing. Input: the finished app + evaluation report. Output: a complete
App Store listing package: app name + subtitle, keywords, description, promotional
text, pricing recommendation, and screenshot/preview specifications.

# Do
- aso-specialist owns name/subtitle/keywords; copywriter owns description/promo
  text; pricing-analyst owns price/IAP model; preview-designer owns screenshot specs.
- Enforce App Store metadata limits (name 30 chars, subtitle 30, keywords 100,
  promo 170) — verify against apple-docs, and reject overlong drafts.
- Package everything into one deliverable ready to paste into App Store Connect.

# Don't
- Don't promise features the app does not have; the deliverable must match the build.
```

- [ ] **Step 2: Write the workers**

`org-template/agents/unit-tester.md`:
```markdown
---
description: Unit test worker — XCTest suites for models and services (run-verified)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: allow
  bash:
    "*": deny
    "swift build*": allow
    "swift test*": allow
    "xcodebuild*": allow
    "xcrun simctl*": allow
    "git status*": allow
    "git diff*": allow
  webfetch: deny
  websearch: deny
---

# Role
You write and run XCTest unit tests for the app's models and services.

# Do
- Test behavior, not implementation; cover edge cases the PRD implies.
- Run the suite and paste a summary of real output in your report.

# Don't
- Don't weaken assertions to make tests pass; report failures as findings.
```

`org-template/agents/ui-tester.md`:
```markdown
---
description: UI test worker — XCUITest flows for critical user journeys (run-verified)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: allow
  bash:
    "*": deny
    "xcodebuild*": allow
    "xcrun simctl*": allow
    "git status*": allow
    "git diff*": allow
  webfetch: deny
  websearch: deny
---

# Role
You write and run XCUITest tests for the critical user flows named in the PRD.

# Do
- One test per journey; use accessibility identifiers, adding them to views only
  if missing (smallest possible diff).
- Run on the simulator and report real results.

# Don't
- Don't test cosmetic details; journeys and state transitions only.
```

`org-template/agents/debugger.md`:
```markdown
---
description: Debugger worker — root-cause analysis and minimal fixes (build/test-verified)
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: allow
  bash:
    "*": deny
    "swift build*": allow
    "swift test*": allow
    "xcodebuild*": allow
    "xcrun simctl*": allow
    "git status*": allow
    "git diff*": allow
    "log show*": allow
  webfetch:
    "*": deny
    "https://developer.apple.com/*": allow
  websearch: deny
---

# Role
You fix one reported failure at a time: reproduce, find the root cause, apply the
minimal fix, prove it with the failing test now passing.

# Do
- State the root cause in one sentence before fixing.
- Re-run the previously failing test AND the surrounding suite; report real output.

# Don't
- Don't fix anything you cannot reproduce; report it as non-reproducible instead.
- Don't refactor beyond the fix.
```

`org-template/agents/aso-specialist.md`:
```markdown
---
description: ASO worker — app name, subtitle, and keyword field (web-enabled)
mode: subagent
model: anthropic/claude-haiku-4-5-20251001
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role
You produce App Store Optimization assets: 3 app-name candidates (<=30 chars),
subtitle (<=30 chars), and a 100-char keyword field, informed by competitor
listings and search-term research.

# Do
- Show character counts next to every asset; never exceed limits.
- Avoid keywords already covered by the name/subtitle (they are indexed separately).

# Don't
- Don't use competitor trademarks in keywords.
```

`org-template/agents/copywriter.md`:
```markdown
---
description: Copywriter worker — App Store description and promotional text
mode: subagent
model: anthropic/claude-haiku-4-5-20251001
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role
You write the App Store description (first 3 lines carry the conversion — they
show before "more") and the 170-char promotional text.

# Do
- Lead with the user's problem, not the app; feature bullets after the hook.
- Provide the copy in the app's store language(s) as instructed by your chief.

# Don't
- Don't claim features that are not in the build report you were given.
```

`org-template/agents/pricing-analyst.md`:
```markdown
---
description: Pricing worker — monetization model and price points (web-enabled)
mode: subagent
model: anthropic/claude-haiku-4-5-20251001
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role
You recommend the monetization model (paid / freemium / subscription / IAP) and
concrete price points, grounded in the competitor pricing from the evaluation
report and current App Store norms for the category.

# Do
- Give one primary recommendation plus one fallback, each with expected trade-offs.

# Don't
- Don't propose pricing that contradicts the evaluation's willingness-to-pay findings.
```

`org-template/agents/preview-designer.md`:
```markdown
---
description: Preview designer worker — screenshot and app-preview specifications
mode: subagent
model: anthropic/claude-sonnet-5
permission:
  edit: deny
  bash: deny
  websearch: allow
  webfetch: allow
---

# Role
You specify the App Store screenshot set and optional app preview video: which
screens, in what order, with what caption text overlay, for the required device
sizes. Output is a production-ready spec, not image files.

# Do
- First screenshot carries the core value proposition; captions <=6 words.
- List exact required resolutions for current iPhone/iPad submission rules
  (verify via apple-docs).

# Don't
- Don't spec screens that don't exist in the built app.
```

- [ ] **Step 3: Write `org-template/README.md`**

```markdown
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
```

- [ ] **Step 4: Commit**

```bash
git add org-template/
git commit -m "feat(org-template): testing, debugging, marketing departments + README

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Template consistency test + full verification

**Files:**
- Test: `packages/opencode/test/kilocode/organization/template.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/opencode/test/kilocode/organization/template.test.ts
import { describe, test, expect } from "bun:test"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import * as ConfigAgent from "../../../src/config/agent"
import { OrgSchema } from "../../../src/kilocode/organization/schema"

const TEMPLATE = path.resolve(import.meta.dir, "../../../../..", "org-template")

async function loadTemplate() {
  const text = await Bun.file(path.join(TEMPLATE, "organization.jsonc")).text()
  const org = OrgSchema.parse(parseJsonc(text))
  const agents = await ConfigAgent.load(TEMPLATE)
  return { org, agents }
}

describe("org-template consistency", () => {
  test("organization.jsonc is structurally valid", async () => {
    const { org } = await loadTemplate()
    expect(OrgSchema.validate(org)).toEqual([])
    expect(org.pipeline.length).toBe(8)
    expect(org.pipeline[0]).toMatchObject({ stage: "evaluation", gate: "human", haltOn: "no-go" })
    expect(org.pipeline[7]).toMatchObject({ stage: "marketing", gate: "human" })
  })

  test("all 26 agent files load and cross-check against the org chart", async () => {
    const { org, agents } = await loadTemplate()
    expect(Object.keys(agents).length).toBe(26)
    const view = Object.fromEntries(
      Object.entries(agents).map(([name, a]) => [
        name,
        { mode: a.mode, subordinates: (a as { subordinates?: readonly string[] }).subordinates },
      ]),
    )
    expect(OrgSchema.crossCheck(org, view)).toEqual([])
  })

  test("ceo is primary; everyone else is a subagent", async () => {
    const { org, agents } = await loadTemplate()
    for (const [name, agent] of Object.entries(agents)) {
      if (name === org.ceo) expect(agent.mode).toBe("primary")
      else expect(agent.mode).toBe("subagent")
    }
  })

  test("chiefs got ordered task permissions from subordinates expansion", async () => {
    const { org, agents } = await loadTemplate()
    for (const dept of Object.values(org.departments)) {
      const chief = agents[dept.chief]
      const task = chief.permission?.task as Record<string, string>
      expect(Object.entries(task)[0]).toEqual(["*", "deny"])
      for (const worker of dept.workers) expect(task[worker]).toBe("allow")
      expect(task["apple-docs"]).toBe("allow")
    }
  })

  test("every agent pins a model", async () => {
    const { agents } = await loadTemplate()
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.model, `agent ${name} must pin a model`).toBeTruthy()
    }
  })

  test("workers have no task permissions (cannot delegate)", async () => {
    const { org, agents } = await loadTemplate()
    const workers = new Set(Object.values(org.departments).flatMap((d) => d.workers).concat(org.shared))
    for (const name of workers) {
      expect(agents[name].permission?.task, `worker ${name} must not have task rules`).toBeUndefined()
    }
  })
})
```

- [ ] **Step 2: Run it — fix template drift, not the test**

```bash
cd packages/opencode && bun test test/kilocode/organization/template.test.ts
```
Expected: all pass. Common failures and their real fixes: agent count ≠ 26 (a file is missing/misnamed — the full roster is: ceo + 8 chiefs (eval, planning, ux, backend, frontend, test, debug, marketing) + 16 workers (market-research, competitor-analysis, feasibility, product-spec, architect, ux-designer, data-layer-dev, swiftui-dev-1, swiftui-dev-2, unit-tester, ui-tester, debugger, aso-specialist, copywriter, pricing-analyst, preview-designer) + apple-docs); crossCheck errors (a chief's `subordinates` list drifted from `organization.jsonc`).

- [ ] **Step 3: Full suite + typecheck**

```bash
cd packages/opencode && bun test test/kilocode/organization/ test/tool/task.test.ts test/permission-task.test.ts test/agent/
cd /Users/mertcanbasak/Now/northstar && bun turbo typecheck
```
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add packages/opencode/test/kilocode/organization/template.test.ts
git commit -m "test(org): template consistency cross-check (26 agents, org chart, permissions)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Manual smoke test (report results, do not skip)**

Create a scratch project and validate the org config end-to-end through the real CLI:

```bash
mkdir -p /tmp/org-smoke && cd /tmp/org-smoke && git init -q
mkdir -p .kilo && cp -r /Users/mertcanbasak/Now/northstar/org-template/. .kilo/
cd /Users/mertcanbasak/Now/northstar && bun run dev -- --help >/dev/null 2>&1 || true
```

Then run the CLI against `/tmp/org-smoke` (`bun run dev` from the repo root starts the TUI; open it in that directory), select the `ceo` agent, and verify: (a) `org_status` returns the org chart with no validation errors, (b) the 26 agents appear in the agent list, (c) a `/build-app test idea` run reaches the evaluation instruct step (you can cancel before any real model spend). Report what you observed honestly in the final summary.

---

## Self-review checklist (run after all tasks)

1. **Spec coverage:** §4 subordinates patch → Tasks 3-5; §5 org schema → Tasks 6, 12; §6 orchestration → Tasks 9-11; §7 permissions/models → Tasks 12-14 templates; §8 error handling → runner incomplete/revise/halt paths (Task 10) + CEO protocol (Task 12); §9 testing → every task + Task 15; dry-run → `org_status` (Task 11) + README.
2. **Markers:** `grep -rn "kilocode_change" packages/opencode/src/tool/task.ts packages/opencode/src/config/agent.ts` — every new edit wrapped.
3. **Ordering invariant:** every permission map in templates has `"*": deny` first.
