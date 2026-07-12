// kilocode_change - new file
import path from "path"
import z from "zod"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceStore } from "@/project/instance-store"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import * as ConfigAgent from "@/config/agent"
import { OrgSchema } from "@/kilocode/organization/schema"
import type { OrgBuilderSaveInput, OrgBuilderSaveOutput } from "../groups/org-builder"

/**
 * Fail-closed validate-then-write pipeline for a serialized organization.jsonc payload. Mirrors
 * `handleInit` (src/kilocode/cli/cmd/org.ts:81-93): parse -> structural validate -> agent
 * cross-check, all issues concatenated, and the file is written ONLY when the combined issue list
 * is empty. Kept as a plain async function (not inline in the Effect handler) so it can be
 * unit-exercised the same way `OrgRunsView` is (see handlers/org-runs.ts).
 */
export async function saveOrganization(
  projectDir: string,
  text: string,
): Promise<typeof OrgBuilderSaveOutput.Type> {
  const parseErrors: ParseError[] = []
  const raw = parseJsonc(text, parseErrors, { allowTrailingComma: true })
  if (parseErrors.length) {
    return {
      ok: false,
      issues: parseErrors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`),
    }
  }

  let org: OrgSchema.Organization
  try {
    org = OrgSchema.parse(raw)
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, issues: [z.prettifyError(err)] }
    }
    throw err
  }

  const structuralIssues = OrgSchema.validate(org)
  const agents = await ConfigAgent.load(path.join(projectDir, ".kilo"))
  const view = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      { mode: agent.mode, subordinates: (agent as { subordinates?: readonly string[] }).subordinates },
    ]),
  )
  const crossCheckIssues = OrgSchema.crossCheck(org, view)
  const issues = [...structuralIssues, ...crossCheckIssues]

  // Fail-closed: any issue at all (structural or cross-check) blocks the write.
  if (issues.length) return { ok: false, issues }

  await OrgSchema.writeOrganization(projectDir, org)
  return { ok: true, issues: [], path: OrgSchema.organizationPath(projectDir) }
}

export const orgBuilderHandlers = HttpApiBuilder.group(InstanceHttpApi, "org-builder", (handlers) =>
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service

    const save = Effect.fn("OrgBuilderHttpApi.save")(function* (ctx: {
      payload: typeof OrgBuilderSaveInput.Type
    }) {
      const instance = yield* InstanceState.context
      const output = yield* Effect.promise(() => saveOrganization(instance.directory, ctx.payload.organization))
      // Only a successful write should hot-reload open TUIs (mirrors agent-builder's post-save
      // dispose) — a rejected (fail-closed) payload changed nothing on disk, so there is nothing to
      // reload for.
      if (output.ok) yield* store.dispose(instance)
      return output
    })

    return handlers.handle("save", save)
  }),
)
