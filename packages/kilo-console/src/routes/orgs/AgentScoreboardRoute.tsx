import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLocation, useParams } from "@solidjs/router"
import { Badge } from "@kilocode/kilo-web-ui/badge"
import { Card } from "@kilocode/kilo-web-ui/card"
import { LoadingScreen } from "../../components/LoadingScreen"
import { discover, forgetCached, loadAgentMetrics, loadCached, resolveServer, saveCached, type ProjectQuery } from "../../client"
import { clean, errMsg } from "../../shared/utils"
import { agentRows, formatCost, formatLatency, formatPercent, healthBadge } from "./agents-view"

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

export function AgentScoreboardRoute() {
  const loc = useLocation()
  const params = useParams()
  const search = createMemo(() => new URLSearchParams(loc.search))
  const fallback = () => base(search())
  const [url, setUrl] = createSignal(fallback())
  const project = () => params.project ?? ""
  // Servers we've already tried to recover FROM via rediscovery. The agent-metrics endpoint can
  // fail while /global/health + /project (what discovery validates) still succeed, so a naive
  // forget→rediscover→re-pin cycle would re-select the same failing server forever, re-scanning
  // ~40 URLs each pass. Bounding recovery to one attempt per distinct URL breaks that loop and
  // lets the error surface. Non-reactive on purpose (mutating it must not re-run the effect).
  const attemptedRecovery = new Set<string>()
  const query = createMemo<ProjectQuery | undefined>(() => {
    const target = clean(url()) || fallback()
    if (!target || !project()) return undefined
    return { url: target, dir: "" }
  })
  const [metrics] = createResource(query, loadAgentMetrics)
  const rows = createMemo(() => agentRows(metrics()))

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
    if (!metrics() || !current || !discoverable(search())) return
    saveCached(current.url)
  })

  createEffect(() => {
    if (!metrics.error || !discoverable(search())) return
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
      <div class="agent-scoreboard-page">
        <header class="agent-scoreboard-header">
          <h1>
            Agent Scoreboard <span class="count-tag">{rows().length}</span>
          </h1>
          <p>Per-agent metrics rolled up across org runs for this project.</p>
        </header>

        <Show when={!query() && discoverable(search())}>
          <LoadingScreen variant="fullscreen" />
        </Show>

        <Show when={metrics.loading && !metrics()}>
          <LoadingScreen variant="fullscreen" />
        </Show>

        <Show when={metrics.error}>
          <Card class="banner" variant="error">
            <strong>Agent metrics request failed</strong>
            <span>{errMsg(metrics.error)}</span>
          </Card>
        </Show>

        <Show when={query() && !metrics.loading && !metrics.error && rows().length === 0}>
          <Card class="empty">No agent metrics yet.</Card>
        </Show>

        <Show when={rows().length > 0}>
          <div class="agent-scoreboard-table" role="table" aria-label="Agent scoreboard">
            <div class="agent-scoreboard-row agent-scoreboard-row-head" role="row">
              <span role="columnheader">Agent</span>
              <span role="columnheader">Runs</span>
              <span role="columnheader">Stages</span>
              <span role="columnheader">Cost</span>
              <span role="columnheader">Success rate</span>
              <span role="columnheader">Avg latency</span>
              <span role="columnheader">Health</span>
            </div>
            <For each={rows()}>
              {(item) => (
                <div class="agent-scoreboard-row" role="row">
                  <span role="cell" class="agent-scoreboard-agent" title={item.agent}>
                    {item.agent}
                  </span>
                  <span role="cell">{item.runs}</span>
                  <span role="cell">{item.stages}</span>
                  <span role="cell" class="agent-scoreboard-cost">
                    {formatCost(item.totalCost)}
                  </span>
                  <span role="cell">{formatPercent(item.successRate)}</span>
                  <span role="cell">{formatLatency(item.avgLatencyMs)}</span>
                  <span role="cell">
                    <Badge variant={healthBadge(item.healthBand)}>{item.healthBand}</Badge>
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </section>
  )
}
