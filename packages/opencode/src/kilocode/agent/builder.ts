import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"

export namespace AgentBuilder {
  export const Scope = z.enum(["global", "project"])
  export type Scope = z.infer<typeof Scope>

  export const Mode = z.enum(["primary", "subagent", "all"])

  export const ID = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)

  export const Params = z.object({
    id: ID,
  })

  const Body = z.object({
    scope: Scope.default("project"),
    description: z.string().optional(),
    mode: Mode.default("primary"),
    model: z.string().optional(),
    color: z.string().optional(),
    steps: z.number().int().positive().optional(),
    tools: z.string().array().optional(),
    permission: z.record(z.string(), z.unknown()).optional(),
    // kilocode_change start - agent-organization: declarative fields the writer must round-trip
    // so agents authored via the Agents editor can participate in an org chart. `subordinates` is
    // expanded into `permission.task` by the loader's `normalize` (src/config/agent.ts), NOT here.
    subordinates: z.string().array().optional(),
    capabilities: z.string().array().optional(),
    preferredTypes: z.string().array().optional(),
    // kilocode_change end
    prompt: z.string().regex(/\S/).trim(),
  })

  export const Input = Body.extend({
    id: ID,
  })
  export type Input = z.infer<typeof Input>

  export const SaveInput = Body.extend({
    id: ID.optional(),
  })
  export type SaveInput = z.infer<typeof SaveInput>

  export const Output = z.object({
    id: ID,
    scope: Scope,
    path: z.string(),
    markdown: z.string(),
  })
  export type Output = z.infer<typeof Output>

  export type Ctx = {
    directory: string
    worktree?: string
  }

  // An agent name that is integer-like ("123") or the "*" wildcard breaks permission-rule
  // ordering: the loader's `normalize` (src/config/agent.ts) expands `subordinates` into
  // `permission.task = { "*": "deny", <name>: "allow", ... }` relying on insertion order so the
  // wildcard deny is written first and later specific allows win under last-match-wins. But JS
  // hoists integer-like string keys ahead of "*", flipping the order so the deny wins and the
  // declared subordinate is silently DENIED. `OrgSchema.invalidName` already rejects such names
  // for org departments/ceo/shared; this guards the agent write path the Agents editor uses.
  function assertSafeName(kind: string, name: string) {
    if (name === "*") throw new Error(`${kind} "*" is not allowed (wildcard collides with permission patterns)`)
    if (/^\d+$/.test(name))
      throw new Error(`${kind} "${name}" is not allowed (integer-like names break permission rule ordering)`)
  }

  export async function preview(ctx: Ctx, input: Input): Promise<Output> {
    assertSafeName("agent id", input.id)
    for (const name of input.subordinates ?? []) assertSafeName("subordinate name", name)
    return {
      id: input.id,
      scope: input.scope,
      path: file(ctx, input.scope, input.id),
      markdown: markdown(input),
    }
  }

  export async function save(ctx: Ctx, input: Input): Promise<Output> {
    const output = await preview(ctx, input)
    await fs.mkdir(path.dirname(output.path), { recursive: true })
    await Filesystem.write(output.path, output.markdown)
    return output
  }

  function file(ctx: Ctx, scope: Scope, id: string) {
    const root =
      scope === "global" ? Global.Path.config : ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
    return path.join(root, scope === "global" ? "agent" : ".kilo/agent", `${id}.md`)
  }

  function markdown(input: Input) {
    const permission = input.tools?.length
      ? {
          ...Object.fromEntries(input.tools.map((tool) => [tool, "allow"])),
          ...input.permission,
        }
      : input.permission
    const data = clean({
      description: input.description,
      mode: input.mode,
      model: input.model,
      color: input.color,
      steps: input.steps,
      permission,
      // kilocode_change start - omit when empty so pre-existing plain agents serialize byte-identically
      subordinates: input.subordinates?.length ? input.subordinates : undefined,
      capabilities: input.capabilities?.length ? input.capabilities : undefined,
      preferredTypes: input.preferredTypes?.length ? input.preferredTypes : undefined,
      // kilocode_change end
    })
    return `---\n${Object.entries(data)
      .map(([key, value]) => `${key}: ${format(value)}`)
      .join("\n")}\n---\n${input.prompt.trim()}\n`
  }

  function clean(input: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
  }

  function format(input: unknown): string {
    if (typeof input === "string") return JSON.stringify(input)
    if (typeof input === "number" || typeof input === "boolean") return String(input)
    return JSON.stringify(input)
  }
}
