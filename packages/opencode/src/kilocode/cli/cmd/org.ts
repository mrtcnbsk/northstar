// kilocode_change - new file
import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import type { Argv } from "yargs"
import { cmd } from "@/cli/cmd/cmd"
import { UI } from "@/cli/ui"
import * as ConfigAgent from "@/config/agent"
import { OrgSchema } from "@/kilocode/organization/schema"

/** Resolves the bundled organization templates/ dir. Mirrors console/assets.ts's dev-vs-bundled
 * resolution so `org init` works both from source (repo-root templates/) and from a compiled
 * binary (build.ts's copyOrgTemplates copies templates/ next to the binary at dist/<pkg>/bin/templates). */
export namespace OrgTemplates {
  export function dir(): string {
    const override = process.env.KILO_ORG_TEMPLATES_DIR
    if (override && existsSync(override)) return override

    const installed = path.join(path.dirname(process.execPath), "templates")
    if (existsSync(installed)) return installed

    // dev/source: repo-root templates/ (src/kilocode/cli/cmd -> ... -> repo root)
    return path.resolve(import.meta.dirname, "../../../../../..", "templates")
  }

  export async function list(templatesDir: string): Promise<string[]> {
    const entries = await fs.readdir(templatesDir, { withFileTypes: true }).catch(() => [])
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  }
}

export interface InitArgs {
  template: string
  force: boolean
  cwd?: string
  templatesDir?: string
  log?: (message: string) => void
  error?: (message: string) => void
  exit?: (code: number) => void
}

export async function handleInit(args: InitArgs): Promise<void> {
  const cwd = args.cwd ?? process.cwd()
  const log = args.log ?? ((message: string) => UI.println(message))
  const error = args.error ?? UI.error
  const exit = args.exit ?? ((code: number) => (process.exitCode = code))
  const templatesDir = args.templatesDir ?? OrgTemplates.dir()

  const source = path.join(templatesDir, args.template)
  if (!existsSync(source)) {
    const available = await OrgTemplates.list(templatesDir)
    error(
      `Unknown template "${args.template}". Available templates: ${
        available.length ? available.join(", ") : "(none found in " + templatesDir + ")"
      }`,
    )
    exit(1)
    return
  }

  const target = path.join(cwd, ".kilo")
  const orgFile = OrgSchema.organizationPath(cwd)
  if (existsSync(orgFile) && !args.force) {
    error(`${orgFile} already exists. Refusing to overwrite. Re-run with --force to replace it.`)
    exit(1)
    return
  }

  // kilocode_change - EPIC 4 review fix: REPLACE (not merge) the template-managed entries so switching
  // to a smaller template can't leave stale agents/command behind (fs.cp only overwrites, never deletes).
  // Removes only what the template provides (organization.jsonc, agents/, command/, README.md) —
  // never .kilo/org/ (run state + memory), which no template contains.
  for (const entry of await fs.readdir(source)) {
    await fs.rm(path.join(target, entry), { recursive: true, force: true })
  }
  await fs.cp(source, target, { recursive: true })

  try {
    const org = await OrgSchema.loadOrganization(cwd)
    const errors = OrgSchema.validate(org)
    const agents = await ConfigAgent.load(target)
    const crossCheckErrors = OrgSchema.crossCheck(
      org,
      Object.fromEntries(
        Object.entries(agents).map(([name, agent]) => [
          name,
          { mode: agent.mode, subordinates: (agent as { subordinates?: readonly string[] }).subordinates },
        ]),
      ),
    )
    const allErrors = [...errors, ...crossCheckErrors]

    const deptCount = Object.keys(org.departments).length
    const stageCount = org.pipeline.length
    const agentCount = Object.keys(agents).length

    if (allErrors.length) {
      error(
        `Scaffolded ${target} from template "${args.template}", but the organization is invalid:\n- ${allErrors.join("\n- ")}`,
      )
      exit(1)
      return
    }

    log(
      `Scaffolded .kilo/ from template "${args.template}": ${deptCount} departments, ${stageCount} pipeline stages, ${agentCount} agents.`,
    )
  } catch (err) {
    error(err instanceof Error ? err.message : String(err))
    exit(1)
  }
}

const OrgInitCommand = cmd({
  command: "init",
  describe: "scaffold .kilo/ from a bundled organization template",
  builder: (yargs: Argv) =>
    yargs
      .option("template", {
        type: "string",
        default: "ios-app-factory",
        describe: "template name (a directory under the bundled templates/)",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "overwrite an existing .kilo/organization.jsonc",
      }),
  handler: async (args) => {
    await handleInit({ template: args.template, force: args.force })
  },
})

export const OrgCommand = cmd({
  command: "org",
  describe: "manage the on-device agent organization",
  builder: (yargs: Argv) => yargs.command(OrgInitCommand).demandCommand(),
  handler: () => {},
})
