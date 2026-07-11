// kilocode_change - new file (W4.3 test helper)
// Collapses a W4.3 `Batch` (parallel instructs + at most one serialized blocker) into the pre-wave
// single-action `{ kind, ... }` shape, using the EXACT precedence tools.ts's org_advance applies:
// halted -> done -> gate -> incomplete -> instruct[0]. This lets the pre-wave runner tests assert
// on the identical values/shape they always did, proving behavior is byte-identical under the
// default maxConcurrency:1 (where instruct has <= 1 element). It is a pure view over the Batch — it
// never re-runs the runner — so it cannot mask a regression; a wrong Batch yields a wrong legacy view.
import { OrgRunner } from "../../../src/kilocode/organization/runner"

export type LegacyAdvance =
  | ({ kind: "instruct" } & OrgRunner.InstructItem)
  | ({ kind: "gate" } & OrgRunner.GateItem)
  | ({ kind: "incomplete" } & OrgRunner.IncompleteItem)
  | { kind: "halted"; reason: string }
  | { kind: "done" }

/** The single action the pre-wave runner would have returned for this batch (tools.ts precedence). */
export function firstAction(batch: OrgRunner.Batch): LegacyAdvance {
  if (batch.halted) return { kind: "halted", reason: batch.halted.reason }
  if (batch.done) return { kind: "done" }
  if (batch.gate) return { kind: "gate", ...batch.gate }
  if (batch.incomplete) return { kind: "incomplete", ...batch.incomplete }
  const first = batch.instruct[0]
  if (first) return { kind: "instruct", ...first }
  // No instruct and no blocker: a "waiting" batch (a branch still in flight). The pre-wave runner
  // never produced this (it always had a single active stage), so tests that hit it are new.
  throw new Error("firstAction: empty batch (no instruct, no blocker) — this is a waiting batch, not a legacy single action")
}

/** Convenience: advance then collapse to the legacy single-action shape. */
export async function advance1(...args: Parameters<typeof OrgRunner.advance>): Promise<LegacyAdvance> {
  return firstAction(await OrgRunner.advance(...args))
}
