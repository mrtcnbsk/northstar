// kilocode_change - new file
import type { AscClient } from "./client"

/**
 * Thin, fixture-testable wrappers over `AscClient` for the App Store Connect delivery flow. Every
 * function takes the client as its first argument so tests inject a fake `fetch` and assert on
 * the exact method/URL/body - no live Apple call, ever.
 *
 * BINARY BUILD UPLOAD SPLIT (read before wiring this into a delivery tool):
 * The ASC JSON:API (this module) does NOT accept the build binary - there is no HTTP endpoint for
 * it. Apple requires the binary to go up via `xcrun altool --upload-app` (or Transporter), which
 * is a *child-process* spawn, not a `fetch` call. That upload path is intentionally NOT
 * implemented here; it belongs in the W7.6 delivery tool, wired through the same shared
 * `ChildProcessSpawner` primitive used by `xcode_archive`/`ipa_export`
 * (`src/kilocode/tool/xcodebuild-exec.ts`). `getBuildStatus` below is this module's JSON-side
 * complement: once altool has pushed a build, ASC processes it asynchronously, and callers poll
 * `/v1/builds` (`attributes.processingState`) here to learn when that processing finished.
 */

export type AscApp = {
  id: string
  bundleId: string
  name: string
}

export type AscAppStoreVersion = {
  id: string
  versionString: string
  appStoreState: string
}

export type AscVersionLocalizationAttrs = Partial<{
  name: string
  subtitle: string
  description: string
  keywords: string
  promotionalText: string
}>

export type AscReviewSubmission = {
  id: string
  state: string
}

export type AscBuildStatus = {
  id: string
  version: string
  processingState: string
}

/** `GET /v1/apps?filter[bundleId]=…` - resolve an app id from its bundle identifier. */
export async function getAppByBundleId(client: AscClient, bundleId: string): Promise<AscApp | undefined> {
  const response = await client.get<{
    data: Array<{ id: string; attributes: { bundleId: string; name: string } }>
  }>(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`)

  const app = response.data[0]
  if (!app) return undefined
  return { id: app.id, bundleId: app.attributes.bundleId, name: app.attributes.name }
}

/**
 * Find-or-create an `appStoreVersions` resource for `versionString` under `appId`. Looks up
 * `/v1/apps/{appId}/appStoreVersions?filter[versionString]=…` first; only `POST
 * /v1/appStoreVersions` when no matching version exists yet.
 */
export async function ensureAppStoreVersion(
  client: AscClient,
  appId: string,
  versionString: string,
  platform: string = "IOS",
): Promise<AscAppStoreVersion> {
  const existing = await client.get<{
    data: Array<{ id: string; attributes: { versionString: string; appStoreState: string } }>
  }>(
    `/v1/apps/${encodeURIComponent(appId)}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}`,
  )

  const found = existing.data[0]
  if (found) {
    return { id: found.id, versionString: found.attributes.versionString, appStoreState: found.attributes.appStoreState }
  }

  const created = await client.post<{
    data: { id: string; attributes: { versionString: string; appStoreState: string } }
  }>("/v1/appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes: { versionString, platform },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  })

  return {
    id: created.data.id,
    versionString: created.data.attributes.versionString,
    appStoreState: created.data.attributes.appStoreState,
  }
}

/** `PATCH /v1/appStoreVersionLocalizations/{id}` with the marketing metadata for one locale. */
export async function updateVersionLocalization(
  client: AscClient,
  localizationId: string,
  attrs: AscVersionLocalizationAttrs,
): Promise<void> {
  await client.patch(`/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`, {
    data: {
      type: "appStoreVersionLocalizations",
      id: localizationId,
      attributes: attrs,
    },
  })
}

/** `POST /v1/reviewSubmissions` - open a review submission for `appId`. */
export async function createReviewSubmission(
  client: AscClient,
  appId: string,
  platform: string = "IOS",
): Promise<AscReviewSubmission> {
  const created = await client.post<{ data: { id: string; attributes: { state: string } } }>(
    "/v1/reviewSubmissions",
    {
      data: {
        type: "reviewSubmissions",
        attributes: { platform },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    },
  )
  return { id: created.data.id, state: created.data.attributes.state }
}

/**
 * Attach `versionId` to an open review submission (`POST /v1/reviewSubmissionItems`), then flip
 * the submission to submitted (`PATCH /v1/reviewSubmissions/{id}` with `attributes.submitted:
 * true`) - the two-step ASC flow that actually sends the version for App Review.
 */
export async function submitForReview(
  client: AscClient,
  reviewSubmissionId: string,
  versionId: string,
): Promise<AscReviewSubmission> {
  await client.post("/v1/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: reviewSubmissionId } },
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  })

  const submitted = await client.patch<{ data: { id: string; attributes: { state: string } } }>(
    `/v1/reviewSubmissions/${encodeURIComponent(reviewSubmissionId)}`,
    {
      data: {
        type: "reviewSubmissions",
        id: reviewSubmissionId,
        attributes: { submitted: true },
      },
    },
  )
  return { id: submitted.data.id, state: submitted.data.attributes.state }
}

/** `GET /v1/appStoreVersions/{versionId}` - read the current `attributes.appStoreState`. */
export async function getReviewState(client: AscClient, versionId: string): Promise<string> {
  const response = await client.get<{ data: { attributes: { appStoreState: string } } }>(
    `/v1/appStoreVersions/${encodeURIComponent(versionId)}`,
  )
  return response.data.attributes.appStoreState
}

/**
 * `GET /v1/builds?filter[app]=…&filter[version]=…` - the JSON-side complement to the altool
 * binary upload (see the module doc comment above): poll this to learn when ASC has finished
 * processing a build that was already uploaded via `xcrun altool --upload-app`.
 */
export async function getBuildStatus(
  client: AscClient,
  appId: string,
  version: string,
): Promise<AscBuildStatus | undefined> {
  const response = await client.get<{
    data: Array<{ id: string; attributes: { version: string; processingState: string } }>
  }>(`/v1/builds?filter[app]=${encodeURIComponent(appId)}&filter[version]=${encodeURIComponent(version)}`)

  const build = response.data[0]
  if (!build) return undefined
  return { id: build.id, version: build.attributes.version, processingState: build.attributes.processingState }
}
