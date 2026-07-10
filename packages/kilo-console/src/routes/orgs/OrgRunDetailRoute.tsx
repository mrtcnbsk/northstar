import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { A, useLocation, useParams } from "@solidjs/router"
import { Badge } from "@kilocode/kilo-web-ui/badge"
import { Card } from "@kilocode/kilo-web-ui/card"
import { LoadingScreen } from "../../components/LoadingScreen"
import {
  discover,
  forgetCached,
  loadCached,
  loadOrgRunDetail,
  resolveServer,
  saveCached,
  type ProjectQuery,
} from "../../client"
import { clean, errMsg } from "../../shared/utils"
import { auditTrail, formatCost, runStatusBadge, stageTimeline } from "./org-runs-view"

const ui = new Set(["3017", "3018"])

function discoverable(search: URLSearchParams) {
  if (search.get("server")) return false
  return ui.has(window.location.port)
}

function base(search: URLSearchParams) {
  const param = search.get("server")
  if (param) return param
  const cached = discoverable(search) ? loadCached() : ""
  if (cached) return cached
  if (discoverable(search)) return ""
  return window.location.origin
}

function timestamp(input: string) {
  if (!input) return "—"
  const time = new Date(input)
  if (Number.isNaN(time.getTime())) return input
  return time.toLocaleString()
}

function notFound(err: unknown) {
  const message = errMsg(err).toLowerCase()
  return message.includes("not found") || message.includes("404")
}

export function OrgRunDetailRoute() {
  const loc = useLocation()
  const params = useParams()
  const search = createMemo(() => new URLSearchParams(loc.search))
  const fallback = () => base(search())
  const [url, setUrl] = createSignal(fallback())
  const project = () => params.project ?? ""
  const runID = () => params.runID ?? ""
  const query = createMemo<{ input: ProjectQuery; runID: string } | undefined>(() => {
    const target = clean(url()) || fallback()
    if (!target || !project() || !runID()) return undefined
    return { input: { url: target, dir: "" }, runID: runID() }
  })
  const [detail] = createResource(query, (item) => loadOrgRunDetail(item.input, item.runID))
  const stages = createMemo(() => stageTimeline(detail()))
  const audit = createMemo(() => auditTrail(detail()))

  function backHref() {
    const next = new URLSearchParams()
    const server = search().get("server")
    if (server) next.set("server", server)
    const suffix = next.toString()
    return `/projects/${encodeURIComponent(project())}/org-runs${suffix ? `?${suffix}` : ""}`
  }

  createEffect(() => {
    const next = search().get("server")
    if (next && next !== url()) setUrl(next)
  })

  createEffect(() => {
    if (!discoverable(search())) return
    void resolveServer().then((value) => {
      if (!value) return
      saveCached(value)
      setUrl(value)
    })
  })

  createEffect(() => {
    const current = query()
    if (!detail() || !current || !discoverable(search())) return
    saveCached(current.input.url)
  })

  createEffect(() => {
    if (!detail.error || !discoverable(search())) return
    const cached = loadCached()
    if (!cached || cached !== url()) return
    forgetCached()
    setUrl("")
    void discover().then((value) => {
      if (!value) return
      saveCached(value)
      setUrl(value)
    })
  })

  return (
    <section class="route-empty">
      <div class="org-run-detail-page">
        <header class="org-run-detail-header">
          <A class="org-run-back" href={backHref()}>
            ← Org Runs
          </A>
          <Show when={detail()}>
            {(info) => (
              <div class="org-run-detail-title">
                <h1>{info().run.idea}</h1>
                <div class="org-run-detail-meta">
                  <Badge variant={runStatusBadge(info().run.status)}>{info().run.status}</Badge>
                  <code title={info().run.runID}>{info().run.runID}</code>
                  <span>{timestamp(info().run.createdAt)}</span>
                  <span class="org-run-detail-cost">
                    {formatCost(typeof info().totalCost === "number" ? (info().totalCost as number) : 0)}
                  </span>
                </div>
                <Show when={info().run.haltReason}>
                  <p class="org-run-halt-reason">Halted: {info().run.haltReason}</p>
                </Show>
              </div>
            )}
          </Show>
        </header>

        <Show when={!query() && discoverable(search())}>
          <LoadingScreen variant="fullscreen" />
        </Show>

        <Show when={detail.loading && !detail()}>
          <LoadingScreen variant="fullscreen" />
        </Show>

        <Show when={detail.error && notFound(detail.error)}>
          <Card class="empty">Org run not found.</Card>
        </Show>

        <Show when={detail.error && !notFound(detail.error)}>
          <Card class="banner" variant="error">
            <strong>Org run request failed</strong>
            <span>{errMsg(detail.error)}</span>
          </Card>
        </Show>

        <Show when={detail()}>
          <section class="org-run-section">
            <h2>Stage Timeline</h2>
            <Show when={stages().length === 0}>
              <Card class="empty">No stages recorded yet.</Card>
            </Show>
            <Show when={stages().length > 0}>
              <ol class="org-run-stage-list">
                <For each={stages()}>
                  {(stage) => (
                    <li class="org-run-stage" classList={{ [`org-run-stage-${stage.status}`]: true }}>
                      <div class="org-run-stage-head">
                        <strong class="org-run-stage-name">{stage.stage}</strong>
                        <Badge variant={stage.badgeVariant}>{stage.status.replace(/_/g, " ")}</Badge>
                      </div>
                      <div class="org-run-stage-meta">
                        <span>{formatCost(stage.cost)}</span>
                        <Show when={stage.startedAt}>
                          <span>Started {timestamp(stage.startedAt)}</span>
                        </Show>
                        <Show when={stage.completedAt}>
                          <span>Completed {timestamp(stage.completedAt)}</span>
                        </Show>
                        <Show when={stage.decision}>
                          <span>Decision: {stage.decision}</span>
                        </Show>
                      </div>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
          </section>

          <section class="org-run-section">
            <h2>Approvals</h2>
            <Show when={audit().length === 0}>
              <Card class="empty">No approval activity recorded yet.</Card>
            </Show>
            <Show when={audit().length > 0}>
              <div class="org-run-audit-table" role="table" aria-label="Approval audit trail">
                <div class="org-run-audit-row org-run-audit-row-head" role="row">
                  <span role="columnheader">Time</span>
                  <span role="columnheader">Stage</span>
                  <span role="columnheader">Decision</span>
                  <span role="columnheader">Note</span>
                </div>
                <For each={audit()}>
                  {(entry) => (
                    <div class="org-run-audit-row" role="row">
                      <span role="cell">{timestamp(entry.ts)}</span>
                      <span role="cell">{entry.stage}</span>
                      <span role="cell">{entry.decision}</span>
                      <span role="cell">{entry.note ?? "—"}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </section>
        </Show>
      </div>
    </section>
  )
}
