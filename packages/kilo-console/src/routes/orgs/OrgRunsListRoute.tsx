import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { A, useLocation, useParams } from "@solidjs/router"
import { Badge } from "@kilocode/kilo-web-ui/badge"
import { Card } from "@kilocode/kilo-web-ui/card"
import { LoadingScreen } from "../../components/LoadingScreen"
import {
  discover,
  forgetCached,
  loadCached,
  loadOrgRuns,
  resolveServer,
  saveCached,
  type OrgRunSummary,
  type ProjectQuery,
} from "../../client"
import { clean, errMsg } from "../../shared/utils"
import { formatCost, runStatusBadge } from "./org-runs-view"

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

function short(input: string) {
  if (input.length <= 8) return input
  return input.slice(0, 8)
}

function truncate(input: string, max = 96) {
  const value = input.trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function timestamp(input: string) {
  const time = new Date(input)
  if (Number.isNaN(time.getTime())) return input
  return time.toLocaleString()
}

function cost(input: OrgRunSummary["totalCost"]) {
  return formatCost(typeof input === "number" && Number.isFinite(input) ? input : 0)
}

export function OrgRunsListRoute() {
  const loc = useLocation()
  const params = useParams()
  const search = createMemo(() => new URLSearchParams(loc.search))
  const fallback = () => base(search())
  const [url, setUrl] = createSignal(fallback())
  const project = () => params.project ?? ""
  // Servers we've already tried to recover FROM via rediscovery. The org-runs endpoint can fail
  // while /global/health + /project (what discovery validates) still succeed, so a naive
  // forget→rediscover→re-pin cycle would re-select the same failing server forever, re-scanning
  // ~40 URLs each pass. Bounding recovery to one attempt per distinct URL breaks that loop and
  // lets the error surface. Non-reactive on purpose (mutating it must not re-run the effect).
  const attemptedRecovery = new Set<string>()
  const query = createMemo<ProjectQuery | undefined>(() => {
    const target = clean(url()) || fallback()
    if (!target || !project()) return undefined
    return { url: target, dir: "" }
  })
  const [runs] = createResource(query, loadOrgRuns)
  const rows = createMemo(() => runs()?.runs ?? [])

  function href(item: OrgRunSummary) {
    const next = new URLSearchParams()
    const server = search().get("server")
    if (server) next.set("server", server)
    const suffix = next.toString()
    return `/projects/${encodeURIComponent(project())}/org-runs/${encodeURIComponent(item.runID)}${suffix ? `?${suffix}` : ""}`
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
    if (!runs() || !current || !discoverable(search())) return
    saveCached(current.url)
  })

  createEffect(() => {
    if (!runs.error || !discoverable(search())) return
    const cached = loadCached()
    if (!cached || cached !== url()) return
    if (attemptedRecovery.has(cached)) return
    attemptedRecovery.add(cached)
    forgetCached()
    void discover().then((value) => {
      // Only switch when discovery finds a DIFFERENT server. If it re-selects the same failing
      // server (or finds none), keep url=cached so the error card renders — never blank the url,
      // which would strand the route on a permanent loading screen.
      if (!value || value === cached) return
      saveCached(value)
      setUrl(value)
    })
  })

  return (
    <section class="route-empty">
      <div class="org-runs-page">
        <header class="org-runs-header">
          <h1>
            Org Runs <span class="count-tag">{rows().length}</span>
          </h1>
          <p>Autonomous org-run pipelines executed for this project.</p>
        </header>

        <Show when={!query() && discoverable(search())}>
          <LoadingScreen variant="fullscreen" />
        </Show>

        <Show when={runs.loading && !runs()}>
          <LoadingScreen variant="fullscreen" />
        </Show>

        <Show when={runs.error}>
          <Card class="banner" variant="error">
            <strong>Org runs request failed</strong>
            <span>{errMsg(runs.error)}</span>
          </Card>
        </Show>

        <Show when={query() && !runs.loading && !runs.error && rows().length === 0}>
          <Card class="empty">No org runs yet.</Card>
        </Show>

        <Show when={rows().length > 0}>
          <div class="org-runs-table" role="table" aria-label="Org runs">
            <div class="org-runs-row org-runs-row-head" role="row">
              <span role="columnheader">Run</span>
              <span role="columnheader">Idea</span>
              <span role="columnheader">Status</span>
              <span role="columnheader">Created</span>
              <span role="columnheader">Cost</span>
              <span role="columnheader">Gate</span>
            </div>
            <For each={rows()}>
              {(item) => (
                <A class="org-runs-row org-runs-row-link" href={href(item)} role="row">
                  <span role="cell" class="org-runs-id" title={item.runID}>
                    {short(item.runID)}
                  </span>
                  <span role="cell" class="org-runs-idea" title={item.idea}>
                    {truncate(item.idea)}
                  </span>
                  <span role="cell">
                    <Badge variant={runStatusBadge(item.status)}>{item.status}</Badge>
                  </span>
                  <span role="cell" class="org-runs-created">
                    {timestamp(item.createdAt)}
                  </span>
                  <span role="cell" class="org-runs-cost">
                    {cost(item.totalCost)}
                  </span>
                  <span role="cell">
                    <Show when={item.awaitingGate}>
                      <Badge variant="default" class="org-runs-gate-badge">
                        Awaiting gate
                      </Badge>
                    </Show>
                  </span>
                </A>
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}
