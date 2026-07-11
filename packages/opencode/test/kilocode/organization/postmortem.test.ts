// kilocode_change - new file
// W6.2: unit tests for the PURE postmortem builder. No filesystem, no LLM, no clock reads -
// `OrgPostmortem.build` is a deterministic function of (run, summary, audit) alone, so every
// assertion here is against a fabricated `OrgState.Run` (never one driven through the runner).
import { describe, test, expect } from "bun:test"
import { OrgPostmortem } from "../../../src/kilocode/organization/postmortem"
import { OrgState } from "../../../src/kilocode/organization/state"
import type { OrgAudit } from "../../../src/kilocode/organization/audit"

function completedRun(): OrgState.Run {
  return {
    runID: "20260711-120000-journal-ai",
    idea: "A journaling app with on-device AI insights",
    createdAt: "2026-07-11T12:00:00.000Z",
    status: "completed",
    stages: {
      plan: {
        status: "completed",
        attempts: 1,
        costs: { ses_plan: 1.25 },
        startedAt: "2026-07-11T12:00:00.000Z",
        completedAt: "2026-07-11T12:10:00.000Z",
      },
      build: {
        status: "completed",
        attempts: 2,
        costs: { ses_build_1: 2, ses_build_2: 1 },
        decision: "approve",
        startedAt: "2026-07-11T12:10:00.000Z",
        completedAt: "2026-07-11T12:30:00.000Z",
      },
      marketing: {
        status: "completed",
        attempts: 1,
        costs: { ses_mkt: 0.5 },
        startedAt: "2026-07-11T12:30:00.000Z",
        completedAt: "2026-07-11T12:40:00.000Z",
      },
    },
  }
}

function noGoAudit(): OrgAudit.Entry[] {
  return [{ ts: "2026-07-11T12:25:00.000Z", stage: "build", decision: "approve", note: "looks solid" }]
}

describe("OrgPostmortem.build (pure)", () => {
  test("completed multi-stage run: markdown carries every stage's status/cost/attempts/decision, total cost, and 'shipped'", () => {
    const run = completedRun()
    const summary = OrgState.runSummary(run)
    const audit = noGoAudit()

    const md = OrgPostmortem.build(run, summary, audit)

    expect(md).toContain(run.runID)
    expect(md).toContain(run.idea)
    // per-stage table rows
    expect(md).toContain("plan")
    expect(md).toContain("build")
    expect(md).toContain("marketing")
    expect(md).toContain("$1.25") // plan cost
    expect(md).toContain("$3") // build cost (2 + 1)
    expect(md).toContain("$0.5") // marketing cost
    expect(md).toContain("approve") // build's decision
    // attempts
    expect(md).toMatch(/\bbuild\b[\s\S]*?\|\s*2\s*\|/)
    // total cost = 1.25 + 3 + 0.5 = 4.75
    expect(summary.totalCost).toBe(4.75)
    expect(md).toContain("$4.75")
    // gate decision from the audit trail
    expect(md).toContain("looks solid")
    // one-line outcome
    expect(md).toContain("shipped")
  })

  test("halted run (no-go): markdown contains 'no-go', the haltReason, and the rejecting stage's decision", () => {
    const run: OrgState.Run = {
      runID: "20260711-130000-halted-idea",
      idea: "An idea that got blocked at review",
      createdAt: "2026-07-11T13:00:00.000Z",
      status: "halted",
      haltReason: "no-go at review: reviewer blocked: hardcoded secret",
      stages: {
        plan: {
          status: "completed",
          attempts: 1,
          costs: { ses_plan: 1 },
          completedAt: "2026-07-11T13:05:00.000Z",
        },
        review: {
          status: "completed",
          attempts: 1,
          decision: "no-go",
          decisionNote: "hardcoded secret",
          costs: { ses_review: 0.75 },
          completedAt: "2026-07-11T13:15:00.000Z",
        },
        marketing: { status: "pending", attempts: 0 },
      },
    }
    const summary = OrgState.runSummary(run)
    const audit: OrgAudit.Entry[] = [
      { ts: "2026-07-11T13:16:00.000Z", stage: "review", decision: "no-go", note: "reviewer blocked: hardcoded secret" },
    ]

    const md = OrgPostmortem.build(run, summary, audit)

    expect(md).toContain("halted")
    expect(md).toContain("no-go")
    expect(md).toContain(run.haltReason!)
    expect(md).toContain("review")
    expect(md).toContain("marketing")
    // pending stage: 0 attempts, $0 cost, no decision
    expect(md).toMatch(/\|\s*marketing\s*\|\s*pending\s*\|\s*\$0\s*\|\s*0\s*\|/)
  })

  test("halted run (retry-exhausted failure, no no-go anywhere): outcome names the failing stage", () => {
    const run: OrgState.Run = {
      runID: "20260711-140000-failed-idea",
      idea: "An idea whose evaluation stage never produced a deliverable",
      createdAt: "2026-07-11T14:00:00.000Z",
      status: "halted",
      haltReason: 'stage "evaluation" failed after 2 incomplete chief runs (deliverable never produced)',
      stages: {
        evaluation: { status: "failed", attempts: 2, incompleteAttempts: 2 },
      },
    }
    const summary = OrgState.runSummary(run)
    const audit: OrgAudit.Entry[] = [
      { ts: "2026-07-11T14:20:00.000Z", stage: "evaluation", decision: "stop", note: run.haltReason },
    ]

    const md = OrgPostmortem.build(run, summary, audit)

    expect(md).toContain("halted at evaluation")
    expect(md).toContain(run.haltReason!)
    expect(OrgPostmortem.keyStage(run)).toBe("evaluation")
  })

  test("determinism: same input always produces the exact same markdown string", () => {
    const run = completedRun()
    const summary = OrgState.runSummary(run)
    const audit = noGoAudit()

    const first = OrgPostmortem.build(run, summary, audit)
    const second = OrgPostmortem.build(run, summary, audit)
    expect(first).toBe(second)

    // A structurally-identical but freshly-constructed input (no shared references) must also
    // produce byte-identical output - proves build() reads nothing but its arguments.
    const rebuilt = OrgPostmortem.build(JSON.parse(JSON.stringify(run)), { ...summary }, JSON.parse(JSON.stringify(audit)))
    expect(rebuilt).toBe(first)
  })

  test("outcome(): shipped / no-go / halted-at-stage, one-liner", () => {
    expect(OrgPostmortem.outcome(completedRun())).toBe("shipped")

    const noGo: OrgState.Run = {
      ...completedRun(),
      status: "halted",
      haltReason: "no-go at review: reviewer blocked",
    }
    expect(OrgPostmortem.outcome(noGo)).toBe("no-go at review: reviewer blocked")

    const failed: OrgState.Run = {
      runID: "x",
      idea: "y",
      createdAt: "2026-07-11T00:00:00.000Z",
      status: "halted",
      haltReason: "budget ceiling exceeded: run $60 / cap $50",
      stages: { build: { status: "failed", attempts: 1 } },
    }
    expect(OrgPostmortem.outcome(failed)).toBe("halted at build: budget ceiling exceeded: run $60 / cap $50")
  })
})
