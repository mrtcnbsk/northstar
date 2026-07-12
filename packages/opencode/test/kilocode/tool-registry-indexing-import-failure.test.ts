import { describe, expect, spyOn, test } from "bun:test"
import { Effect, Schema } from "effect"
import * as Log from "@opencode-ai/core/util/log"
import { KiloToolRegistry } from "../../src/kilocode/tool/registry"
import { Agent } from "../../src/agent/agent"
import * as Truncate from "../../src/tool/truncate"
import type * as Tool from "../../src/tool/tool"

const logger = Log.create({ service: "kilocode-tool-registry" })
const deps = { agent: {} as Agent.Interface, truncate: {} as Truncate.Interface }

describe("kilocode tool registry indexing import failure", () => {
  test("omits semantic_search when the indexing module cannot load", async () => {
    const err = new Error("indexing import failed")
    const warn = spyOn(logger, "warn").mockImplementation(() => {})

    try {
      const result = await Effect.runPromise(
        KiloToolRegistry.build(infos(), deps, {
          indexing: async () => {
            throw err
          },
        }),
      )

      expect(result.semantic).toBeUndefined()
      expect(result.recall.id).toBe("recall")
      expect(warn.mock.calls[0]?.[0]).toBe("semantic search unavailable")
      expect(warn.mock.calls[0]?.[1]?.err).toBeDefined()
    } finally {
      warn.mockRestore()
    }
  })
})

function infos() {
  return {
    codebase: info("codebase_search"),
    recall: info("recall"),
    managerModels: info("agent_manager_models"),
    memory: info("kilo_memory_recall"),
    save: info("kilo_memory_save"),
    manager: info("agent_manager"),
    process: info("background_process"),
    image: info("generate_image"),
    xcodeBuild: info("xcode_build"),
    xcodeTest: info("xcode_test"),
    xcodeArchive: info("xcode_archive"),
    ipaExport: info("ipa_export"),
    crashSymbolicate: info("crash_symbolicate"),
    privacyManifestCheck: info("privacy_manifest_check"),
    atsCheck: info("ats_check"),
    secretScan: info("secret_scan"),
    ascMetadataValidate: info("asc_metadata_validate"),
    ascSubmit: info("asc_submit"),
    ascStatus: info("asc_status"),
    orgStart: info("org_start"),
    orgAdvance: info("org_advance"),
    orgDecision: info("org_decision"),
    orgStatus: info("org_status"),
    orgStop: info("org_stop"),
    orgNote: info("org_note"),
    orgMemorySave: info("org_memory_save"),
    orgRecall: info("org_recall"),
    orgSearch: info("org_search"),
    routeTask: info("org_route"),
    notebookRead: info("notebook_read"),
    notebookEdit: info("notebook_edit"),
    notebookExecute: info("notebook_execute"),
  }
}

function info(id: string): Tool.Info {
  return {
    id,
    init: () =>
      Effect.succeed({
        description: id,
        parameters: Schema.String,
        execute: () => Effect.succeed({ title: id, output: id, metadata: {} }),
      }),
  }
}
