# GitHub Actions Runner Recovery and v0.1.1 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore fork-compatible GitHub Actions execution, clear permanently queued runs, and publish Northstar v0.1.1 from `main`.

**Architecture:** Replace upstream Blacksmith runner labels in every active workflow with equivalent GitHub-hosted labels while preserving each job's operating system and architecture. Verify the workflow source locally, push the isolated CI fix to `main`, confirm fresh GitHub jobs acquire runners, then invoke the existing publish workflow with an explicit stable patch bump so the three pending changesets become the v0.1.1 release notes.

**Tech Stack:** GitHub Actions YAML, GitHub CLI, Bun, Changesets, npm, GitHub Releases.

## Global Constraints

- Work directly on the already-approved `main` branch.
- Preserve all backend `KILO_*` compatibility identifiers.
- Use GitHub-hosted runners only in active workflows for this fork.
- Publish a stable patch release with `pre_release=false`.
- Do not expose or copy repository secrets into logs or commits.

---

### Task 1: Replace unavailable runner labels

**Files:**
- Modify: `.github/workflows/beta.yml`
- Modify: `.github/workflows/check-org-member.yml`
- Modify: `.github/workflows/docs-build.yml`
- Modify: `.github/workflows/generate.yml`
- Modify: `.github/workflows/kilo-auto-close.yml`
- Modify: `.github/workflows/nix-eval.yml`
- Modify: `.github/workflows/nix-hashes.yml`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/typecheck.yml`
- Modify: `.github/workflows/visual-regression.yml`

**Interfaces:**
- Consumes: Existing `runs-on` scalar values and the JSON matrix emitted by `test.yml`.
- Produces: GitHub-hosted labels `ubuntu-24.04`, `ubuntu-24.04-arm`, and `windows-2025` with unchanged OS/architecture intent.

- [ ] **Step 1: Run the failing runner-policy check**

```sh
if rg -n 'blacksmith-' .github/workflows -g '*.yml' -g '!disabled/**'; then
  echo 'FAIL: fork-incompatible Blacksmith runner labels remain in active workflows'
  exit 1
fi
```

Expected: exit 1 with the active workflow occurrences listed.

- [ ] **Step 2: Apply the minimal label mapping**

```text
blacksmith-2vcpu-ubuntu-2404     -> ubuntu-24.04
blacksmith-4vcpu-ubuntu-2404     -> ubuntu-24.04
blacksmith-4vcpu-ubuntu-2404-arm -> ubuntu-24.04-arm
blacksmith-4vcpu-windows-2025    -> windows-2025
```

- [ ] **Step 3: Re-run the runner-policy check**

Run the Step 1 command again.

Expected: exit 0 with no matches.

- [ ] **Step 4: Validate workflow policy and syntax**

```sh
bun run script/check-workflows.ts
actionlint .github/workflows/*.yml
```

Expected: both commands exit 0. If `actionlint` is unavailable, parse all active YAML files with the repository's installed YAML parser and report that substitution explicitly.

- [ ] **Step 5: Commit and push the CI fix**

```sh
git add .github/workflows docs/superpowers/plans/2026-07-12-github-actions-runner-and-release.md
git commit -m "fix(ci): use GitHub-hosted runners"
git push --no-verify origin main
```

Expected: `origin/main` advances to the CI fix commit.

### Task 2: Prove runner recovery and clear stale runs

**Files:**
- No repository files.

**Interfaces:**
- Consumes: Fresh `test` and `typecheck` workflow runs created by the Task 1 push.
- Produces: Completed checks for the new commit and no obsolete queued Blacksmith runs.

- [ ] **Step 1: Inspect new jobs and runner assignment**

```sh
gh run list -R mrtcnbsk/northstar --branch main --limit 20 \
  --json databaseId,workflowName,status,conclusion,headSha,url
```

Expected: new `test` and `typecheck` runs reference the CI fix commit and move beyond `queued`.

- [ ] **Step 2: Wait for the relevant new runs**

```sh
gh run watch <test-run-id> -R mrtcnbsk/northstar --exit-status
gh run watch <typecheck-run-id> -R mrtcnbsk/northstar --exit-status
```

Expected: both exit 0. On failure, inspect the failing job log before changing code.

- [ ] **Step 3: Cancel only obsolete queued runs**

List queued runs, select runs whose `headSha` predates the CI fix, and execute:

```sh
gh run cancel <stale-run-id> -R mrtcnbsk/northstar
```

Expected: permanently queued Blacksmith-era runs transition to `completed/cancelled`; the fresh validated runs remain untouched.

### Task 3: Publish Northstar v0.1.1

**Files:**
- Workflow-generated on `main`: package version files, `bun.lock`, `packages/opencode/CHANGELOG.md`, and consumed `.changeset/*.md` files.

**Interfaces:**
- Consumes: v0.1.0 as the highest stable release and the three pending patch changesets.
- Produces: release commit `release: v0.1.1`, tag `v0.1.1`, npm packages on the `latest` channel, and a published GitHub release.

- [ ] **Step 1: Verify stable release inputs**

```sh
git fetch origin --prune --tags
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test "$(gh release view v0.1.0 -R mrtcnbsk/northstar --json isDraft --jq .isDraft)" = "false"
test "$(find .changeset -maxdepth 1 -name '*.md' ! -name README.md | wc -l | tr -d ' ')" = "3"
```

Expected: all commands exit 0.

- [ ] **Step 2: Dispatch an explicit stable patch release**

```sh
gh workflow run publish.yml -R mrtcnbsk/northstar --ref main \
  -f bump=patch -f pre_release=false
```

Expected: a new publish workflow run appears with display title `release patch`.

- [ ] **Step 3: Watch the publish workflow to completion**

```sh
gh run watch <publish-run-id> -R mrtcnbsk/northstar --exit-status
```

Expected: exit 0 after CLI build, cross-platform smoke tests, npm publication, release commit/tag push, and GitHub release publication.

- [ ] **Step 4: Verify all release surfaces**

```sh
git fetch origin --prune --tags
test "$(git tag --points-at origin/main)" = "v0.1.1"
test "$(gh release view v0.1.1 -R mrtcnbsk/northstar --json isDraft,isPrerelease --jq '[.isDraft,.isPrerelease] | @tsv')" = $'false\tfalse'
test "$(npm view @ilura/northstar@0.1.1 version)" = "0.1.1"
test "$(git show origin/main:packages/opencode/package.json | jq -r .version)" = "0.1.1"
```

Expected: every command exits 0 and reports v0.1.1 as a stable release.

## Self-Review

- Spec coverage: root-cause fix, stale queue cleanup, push to `main`, and stable release are each represented by an independently verifiable task.
- Placeholder scan: no deferred implementation markers or incomplete steps remain.
- Type consistency: runner labels preserve the existing Linux x64, Linux arm64, and Windows x64 matrix semantics; release inputs match `publish.yml` (`bump`, `pre_release`).
