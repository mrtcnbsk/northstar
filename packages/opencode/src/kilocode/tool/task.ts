// kilocode_change - new file
import { Effect, Schema } from "effect"
import path from "path"
import { Permission } from "@/permission"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Session } from "../../session/session"
import type { Agent } from "../../agent/agent"
import type { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import z from "zod"

const log = Log.create({ service: "kilocode-task-model" })

// RATIONALE: Mirror narrow state slice Task tool consumes and ignore unrelated TUI fields.
const ModelState = z
  .object({
    model: z
      .record(
        z.string(),
        z.object({
          providerID: z.custom<ProviderID>(Schema.is(ProviderID)),
          modelID: z.custom<ModelID>(Schema.is(ModelID)),
        }),
      )
      .optional(),
    variant: z.record(z.string(), z.string().optional()).optional(),
  })
  .passthrough()

export namespace KiloTask {
  /** Reject primary agents used as subagents */
  export function validate(info: Agent.Info, name: string) {
    if (info.mode === "primary") throw new Error(`Agent "${name}" is a primary agent and cannot be used as a subagent`)
  }

  /**
   * Kilo historically kept delegation one level deep. The agent-organization
   * layer relaxes this for "manager" subagents only. kilocode_change - W1.0b:
   * the documented contract is now "delegation requires declared subordinates" —
   * an agent may spawn subagents iff its author declared a non-empty
   * `subordinates` list (frontmatter / config field). The ruleset is no longer
   * consulted for DETECTION: a user's global permission config (e.g.
   * `permission: { task: {"*": "deny", x: "allow"} }`) merges into every
   * agent's ruleset and could manufacture the old signature on plain workers
   * and built-ins. Spawn AUTHORITY is still enforced at ask time by the task
   * permission rules the subordinates expansion emits (config/agent.ts).
   * Depth is separately capped by OrgDepth.guard in the task tool.
   */
  export function nestedTask(subagent: Agent.Info): boolean {
    return (subagent.subordinates?.length ?? 0) > 0 // kilocode_change - W1.0b: keyed on the declaration, not the ruleset
  }

  // kilocode_change start - W1.0/W1.0b: declared-subordinate deny relaxation (restores org write path)
  // Keep in sync with the planner agent names: PLANNERS in src/kilocode/plan-file.ts
  // ("plan", "architect") plus the read-only "ask" built-in (src/kilocode/agent/index.ts).
  const PLAN_FAMILY = new Set(["ask", "plan", "architect"])

  /** True when `parent` explicitly manages `child` as a declared subordinate:
   * the parent's author-declared `subordinates` list (frontmatter / config field)
   * contains the child's EXACT name — subordinates are exact agent names, never
   * patterns. W1.0b re-keyed this from the ruleset manager-signature (task
   * deny-by-default + specific allow), which a user's global deny-by-default task
   * policy could manufacture on built-ins like `explore`. Global config cannot
   * inject a `subordinates` declaration. The PLAN_FAMILY name gate is redundant
   * today (no plan-family agent declares subordinates) but kept as a cheap
   * defense-in-depth belt. Used to skip forwarding parent AGENT-level denies on
   * org edges — parent SESSION denies always forward. Hand-written non-org agents
   * that declare subordinates opt their edges into child-governed permissions by
   * design: same trust domain (see docs/superpowers/tracked-followups.md ACCEPT). */
  export function declaredSubordinate(parent: Agent.Info | undefined, child: string): boolean {
    if (!parent) return false
    if (PLAN_FAMILY.has(parent.name.toLowerCase())) return false
    if (!child) return false
    return parent.subordinates?.includes(child) ?? false
  }
  // kilocode_change end

  /**
   * Build inherited permission ceilings from the calling agent.
   * Merges the static agent definition with the session's accumulated permissions
   * so denials survive multi-hop chains (plan → general → explore) without
   * overriding the selected subagent's own allowlist with parent ask/allow rules.
   *
   * OpenCode removed parent-agent inheritance entirely in anomalyco/opencode#31696.
   * Kilo intentionally differs: parent denials remain hard ceilings for Plan Mode
   * and MCP restrictions, while parent ask/allow rules must not replace the
   * selected subagent's policy. Preserve this distinction during upstream merges.
   *
   * The caller must resolve `caller` (Agent.Info) and `session` (Session.Info)
   * before calling. This function is pure/synchronous.
   *
   * kilocode_change - W1.0: when `caller` explicitly declares `subagent` as a managed
   * subordinate (see `declaredSubordinate`), the caller's own AGENT ruleset is excluded
   * from the merge — only the parent SESSION's accumulated permissions still apply. This
   * is what lets a chief's `edit: deny "*"` (needed so the chief itself cannot write app
   * code) stop from forwarding into a worker session that must be able to write it.
   */
  export function inherited(input: {
    caller: Agent.Info
    session: Session.Info
    mcp: Config.Info["mcp"]
    subagent?: Agent.Info // kilocode_change - W1.0
  }): Permission.Ruleset {
    // kilocode_change start - W1.0: skip the caller's own ruleset on a declared-subordinate edge
    const skipCallerRuleset = declaredSubordinate(input.caller, input.subagent?.name ?? "")
    const rules = Permission.merge(
      skipCallerRuleset ? [] : (input.caller.permission ?? []),
      input.session.permission ?? [],
    )
    // kilocode_change end
    const prefixes = Object.keys(input.mcp ?? {}).map((k) => k.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
    const isMcp = (p: string) => prefixes.some((prefix) => p.startsWith(prefix))
    return rules.filter(
      (r: Permission.Rule) =>
        r.action === "deny" && (r.permission === "edit" || r.permission === "bash" || isMcp(r.permission)),
    )
  }

  /** Extra permission rules appended to subagent sessions */
  export function permissions(rules: Permission.Ruleset, opts?: { canTask?: boolean }): Permission.Ruleset {
    return [
      ...(opts?.canTask ? [] : [{ permission: "task", pattern: "*", action: "deny" } as const]),
      { permission: "question", pattern: "*", action: "deny" },
      { permission: "interactive_terminal", pattern: "*", action: "deny" },
      ...rules,
    ]
  }

  export function merge(...rulesets: Permission.Ruleset[]): Permission.Rule[] {
    const result: Permission.Rule[] = []
    const seen = new Set<string>()
    for (const rule of rulesets.flat()) {
      const key = `${rule.permission}\u0000${rule.pattern}\u0000${rule.action}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(rule)
    }
    return result
  }

  type Model = { providerID: ProviderID; modelID: ModelID }
  type Saved = Model & { variant?: string }
  type Choice = { model: Model; variant?: string; sticky?: boolean; direct?: boolean }

  function key(model: Model) {
    return `${model.providerID}/${model.modelID}`
  }

  function parse(value: string | null | undefined): Model | undefined {
    if (!value) return undefined
    const [providerID, ...parts] = value.split("/")
    return {
      providerID: ProviderID.make(providerID),
      modelID: ModelID.make(parts.join("/")),
    }
  }

  const saved = Effect.fn("KiloTask.savedModel")(function* (name: string) {
    if (Flag.KILO_CLIENT !== "cli") return undefined
    const file = path.join(Global.Path.state, "model.json")
    const state = yield* Effect.tryPromise({
      try: () =>
        Bun.file(file)
          .text()
          .then((raw) => ModelState.safeParse(JSON.parse(raw)))
          .then((result) => (result.success ? result.data : undefined))
          .catch(() => undefined),
      catch: () => undefined,
    })
    const model = state?.model?.[name]
    if (!model) return undefined
    return {
      ...model,
      variant: state?.variant?.[`${model.providerID}/${model.modelID}`],
    }
  })

  // kilocode_change start - W1.5: cost-aware fallback ranking, used only when a configured
  // model is confirmed UNAVAILABLE (see `unavailable` flag in resolveModel below).
  //
  // INVARIANT: this never runs against a HEALTHY configured model. Agents pin models
  // deliberately (direct agent.model, saved sticky model, or subagent_model config) and a
  // model that resolves successfully is always honored as-is, unchanged and unranked. Cost
  // ranking is exclusively a replacement for the blunt "jump straight to the parent model"
  // fallback that previously fired the instant ANY configured choice above failed to resolve.
  //
  // Reality check (W1.5 prereq, see docs/superpowers/plans/2026-07-10-wave-1-budget.md): the
  // upstream `Model` schema (src/provider/provider.ts) carries reliable numeric pricing on
  // every model via `cost.input` / `cost.output` (Schema.Finite, not optional/best-effort),
  // and `Provider.Interface.list()` returns the live connected-provider catalog (not the full
  // static models.dev catalog) already reachable from the same `Provider.Interface` this
  // function receives as `input.provider`. Both preconditions hold, so this implements the
  // cost-ranked branch rather than an ordered `fallback_models` list.
  function rank(providers: Record<ProviderID, Provider.Info>): Model[] {
    const candidates: Array<{ model: Model; price: number }> = []
    for (const [providerID, provider] of Object.entries(providers) as Array<[ProviderID, Provider.Info]>) {
      for (const [modelID, info] of Object.entries(provider.models)) {
        if (!info.capabilities.toolcall) continue // subagents must be able to call tools
        if (info.status === "deprecated") continue // not a "capable" candidate for fresh delegation
        const price = (info.cost?.input ?? 0) + (info.cost?.output ?? 0)
        candidates.push({ model: { providerID, modelID: ModelID.make(modelID) }, price })
      }
    }
    candidates.sort((a, b) => a.price - b.price)
    return candidates.map((c) => c.model)
  }

  /** Walk the cost-ranked catalog, skipping entries that are themselves unavailable
   * (extends the chain past the FLOOR's 2 levels: a ranked model can itself 404 and the
   * walk falls through to the next-cheapest, etc.). Returns undefined if every ranked
   * candidate is unavailable, so the caller can fall through to the original parent-fallback
   * tail unchanged. */
  const rankedFallback = Effect.fn("KiloTask.rankedFallback")(function* (input: {
    provider: Provider.Interface
    exclude: Set<string>
  }) {
    const providers = yield* input.provider.list()
    const ranked = rank(providers)
    for (const candidate of ranked) {
      if (input.exclude.has(key(candidate))) continue
      const full = yield* input.provider.getModel(candidate.providerID, candidate.modelID).pipe(
        Effect.catchTag("ProviderModelNotFoundError", (err) =>
          Effect.sync(() => {
            log.debug("skipping unavailable ranked fallback candidate", {
              providerID: candidate.providerID,
              modelID: candidate.modelID,
              err,
            })
            return undefined
          }),
        ),
      )
      if (!full) continue
      return { model: candidate, full }
    }
    return undefined
  })
  // kilocode_change end

  /** Resolve the task subagent model while discarding stale unavailable overrides. */
  export const resolveModel = Effect.fn("KiloTask.resolveModel")(function* (input: {
    name: string
    agent: Pick<Agent.Info, "model" | "variant">
    config: Pick<Config.Info, "subagent_model" | "subagent_variant" | "subagent_variant_overrides">
    parent: Model
    variant?: string
    provider: Provider.Interface
  }) {
    const state = yield* saved(input.name)
    const cfg = parse(input.config.subagent_model)
    const override = (model: Model) => input.config.subagent_variant_overrides?.[key(model)] ?? undefined
    const choices: Array<Choice | undefined> = [
      state
        ? {
            model: { providerID: state.providerID, modelID: state.modelID },
            variant: state.variant,
            sticky: true,
          }
        : undefined,
      input.agent.model ? { model: input.agent.model, variant: input.agent.variant, direct: true } : undefined,
      cfg ? { model: cfg, variant: input.config.subagent_variant ?? undefined } : undefined,
    ]

    // kilocode_change - W1.5: true only when a configured choice above was CONFIRMED
    // unavailable (ProviderModelNotFoundError), never for a choice that was simply absent
    // (e.g. no subagent_model configured). Gates cost-ranked fallback vs. the original
    // unconditional jump to `input.parent`.
    let unavailable = false
    const tried = new Set<string>()

    for (const choice of choices) {
      if (!choice) continue
      tried.add(key(choice.model))
      if (choice.direct) {
        const value = override(choice.model)
        if (!value) return { model: choice.model, variant: choice.variant }
        const full = yield* input.provider.getModel(choice.model.providerID, choice.model.modelID)
        const variant = full.variants?.[value] ? value : choice.variant
        return { model: choice.model, variant }
      }
      const full = yield* input.provider.getModel(choice.model.providerID, choice.model.modelID).pipe(
        Effect.catchTag("ProviderModelNotFoundError", (err) =>
          Effect.sync(() => {
            log.debug("skipping unavailable task subagent model", {
              providerID: choice.model.providerID,
              modelID: choice.model.modelID,
              err,
            })
            unavailable = true // kilocode_change - W1.5
            return undefined
          }),
        ),
      )
      if (!full) continue
      const fallback = choice.variant && full.variants?.[choice.variant] ? choice.variant : undefined
      const value = override(choice.model)
      const variant = value && full.variants?.[value] ? value : fallback
      return {
        model: choice.sticky && variant ? { ...choice.model, variant } : choice.model,
        variant,
      }
    }

    // kilocode_change start - W1.5: cost-ranked fallback replaces the blunt parent jump, but
    // ONLY when something configured was confirmed unavailable above. Absence (nothing
    // configured) keeps the original unconditional parent-fallback behavior unchanged.
    if (unavailable) {
      tried.add(key(input.parent))
      const picked = yield* rankedFallback({ provider: input.provider, exclude: tried })
      if (picked) {
        const value = override(picked.model)
        const variant = value && picked.full.variants?.[value] ? value : undefined
        return { model: picked.model, variant }
      }
    }
    // kilocode_change end

    const value = override(input.parent)
    if (!value) return { model: input.parent, variant: input.variant }
    const full = yield* input.provider
      .getModel(input.parent.providerID, input.parent.modelID)
      .pipe(Effect.catchTag("ProviderModelNotFoundError", () => Effect.succeed(undefined)))
    const variant = full?.variants?.[value] ? value : input.variant
    return { model: input.parent, variant }
  })
}
