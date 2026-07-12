// kilocode_change - new file
/**
 * Org-level toolpacks: opt-in bundles that gate tool VISIBILITY (not execution - execution stays
 * governed by `config/permission.ts`). A project's `.kilo/organization.jsonc` opts in via
 * `toolpacks: ["apple-delivery"]`; `KiloToolRegistry.applyVisibility` hides every tool id in a
 * pack's `toolIds` from every agent until that pack is opted into (see `TOOLPACK_BY_TOOL_ID`
 * below, consumed by `registry.ts`). `agents` is INFORMATIONAL only - it documents which agents
 * the pack's tools are meant for; the gate itself is driven exclusively by `toolIds`.
 */
export const TOOLPACKS: Record<string, { toolIds: Set<string>; agents: string[] }> = {
  "apple-delivery": {
    // The Apple build/delivery tools. `secret_scan` is intentionally NOT included - it is generic
    // (useful to any project, Apple or not) and stays visible in the base tool set.
    toolIds: new Set([
      "xcode_build",
      "xcode_test",
      "xcode_archive",
      "ipa_export",
      "crash_symbolicate",
      "privacy_manifest_check",
      "ats_check",
      "asc_metadata_validate",
      "asc_submit",
      "asc_status",
    ]),
    agents: [
      // Validators
      "accessibility-validator",
      "api-availability-validator",
      "appstore-review-validator",
      "entitlement-validator",
      "hig-validator",
      "localization-validator",
      "privacy-manifest-validator",
      "swift6-migration-validator",
      // Experts (all *-expert) + apple-docs
      "activitykit-expert",
      "appintents-expert",
      "appkit-expert",
      "apple-intelligence-expert",
      "avfoundation-expert",
      "carplay-expert",
      "cloudkit-expert",
      "coredata-expert",
      "corelocation-expert",
      "coreml-expert",
      "foundation-models-expert",
      "healthkit-expert",
      "homekit-expert",
      "macos-expert",
      "metal-expert",
      "siri-expert",
      "storekit-expert",
      "swiftdata-expert",
      "swiftui-expert",
      "uikit-expert",
      "vision-expert",
      "visionos-expert",
      "watchos-expert",
      "widgetkit-expert",
      "apple-docs",
      // Delivery + marketing + frontend agents
      "delivery-chief",
      "release-engineer",
      "aso-specialist",
      "preview-designer",
      "swiftui-dev-1",
      "swiftui-dev-2",
    ],
  },
}

/** Reverse index: toolId -> the pack it belongs to. Built once from TOOLPACKS. */
export const TOOLPACK_BY_TOOL_ID: Map<string, string> = new Map(
  Object.entries(TOOLPACKS).flatMap(([pack, { toolIds }]) => [...toolIds].map((id) => [id, pack] as const)),
)
