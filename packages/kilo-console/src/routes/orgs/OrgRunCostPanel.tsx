import { For, Show } from "solid-js"
import { Card } from "@kilocode/kilo-web-ui/card"
import type { OrgRunDetailResponse } from "../../client"
import { costRows, costTotal, formatCost } from "./org-runs-view"

export function OrgRunCostPanel(props: { detail: OrgRunDetailResponse | undefined }) {
  const rows = () => costRows(props.detail)
  const total = () => costTotal(props.detail)

  return (
    <section class="org-run-section">
      <h2>Cost</h2>
      <Show when={rows().length === 0}>
        <Card class="empty">No stage costs recorded yet.</Card>
      </Show>
      <Show when={rows().length > 0}>
        <div class="org-run-cost-table" role="table" aria-label="Run cost breakdown">
          <div class="org-run-cost-row org-run-cost-row-head" role="row">
            <span role="columnheader">Stage</span>
            <span role="columnheader">Cost</span>
          </div>
          <For each={rows()}>
            {(row) => (
              <div class="org-run-cost-row" role="row">
                <span role="cell" class="org-run-cost-stage">
                  {row.stage}
                </span>
                <span role="cell" class="org-run-cost-value">
                  {formatCost(row.cost)}
                </span>
              </div>
            )}
          </For>
          <div class="org-run-cost-row org-run-cost-row-total" role="row">
            <span role="cell" class="org-run-cost-stage">
              Total
            </span>
            <span role="cell" class="org-run-cost-value">
              {formatCost(total())}
            </span>
          </div>
        </div>
      </Show>
    </section>
  )
}
