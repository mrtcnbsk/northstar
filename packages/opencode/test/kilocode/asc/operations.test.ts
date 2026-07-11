// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { AscClient, AscError } from "../../../src/kilocode/asc/client"
import type { AscCredential } from "../../../src/kilocode/asc/auth"
import {
  getAppByBundleId,
  ensureAppStoreVersion,
  updateVersionLocalization,
  createReviewSubmission,
  submitForReview,
  getReviewState,
  getBuildStatus,
} from "../../../src/kilocode/asc/operations"

const FIXED = 1_700_000_000_000

type Call = { url: string; method: string; body: unknown }

function makeClient(handler: (call: Call) => Response) {
  const calls: Call[] = []
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const credential: AscCredential = {
    issuerId: "ISS",
    keyId: "KID",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  const client = new AscClient({ credential, fetch: fetchImpl, now: () => FIXED })
  return { client, calls }
}

describe("asc/operations", () => {
  test("getAppByBundleId builds the bundleId filter query and maps the response", async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            data: [{ id: "app-1", attributes: { bundleId: "com.example.app", name: "Example" } }],
          }),
          { status: 200 },
        ),
    )

    const app = await getAppByBundleId(client, "com.example.app")

    expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=com.example.app")
    expect(calls[0]?.method).toBe("GET")
    expect(app).toEqual({ id: "app-1", bundleId: "com.example.app", name: "Example" })
  })

  test("getAppByBundleId returns undefined when no app matches", async () => {
    const { client } = makeClient(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const app = await getAppByBundleId(client, "com.example.missing")
    expect(app).toBeUndefined()
  })

  test("ensureAppStoreVersion finds an existing version without creating one", async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === "GET") {
        return new Response(
          JSON.stringify({
            data: [
              { id: "ver-1", attributes: { versionString: "1.2.0", appStoreState: "PREPARE_FOR_SUBMISSION" } },
            ],
          }),
          { status: 200 },
        )
      }
      throw new Error("should not POST when a version already exists")
    })

    const version = await ensureAppStoreVersion(client, "app-1", "1.2.0")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(
      "https://api.appstoreconnect.apple.com/v1/apps/app-1/appStoreVersions?filter[versionString]=1.2.0",
    )
    expect(version).toEqual({ id: "ver-1", versionString: "1.2.0", appStoreState: "PREPARE_FOR_SUBMISSION" })
  })

  test("ensureAppStoreVersion creates a version when none exists", async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === "GET") return new Response(JSON.stringify({ data: [] }), { status: 200 })
      return new Response(
        JSON.stringify({
          data: { id: "ver-2", attributes: { versionString: "1.3.0", appStoreState: "PREPARE_FOR_SUBMISSION" } },
        }),
        { status: 201 },
      )
    })

    const version = await ensureAppStoreVersion(client, "app-1", "1.3.0")

    expect(calls).toHaveLength(2)
    expect(calls[1]?.method).toBe("POST")
    expect(calls[1]?.url).toBe("https://api.appstoreconnect.apple.com/v1/appStoreVersions")
    expect(calls[1]?.body).toEqual({
      data: {
        type: "appStoreVersions",
        attributes: { versionString: "1.3.0", platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: "app-1" } } },
      },
    })
    expect(version).toEqual({ id: "ver-2", versionString: "1.3.0", appStoreState: "PREPARE_FOR_SUBMISSION" })
  })

  test("updateVersionLocalization sends the ASC {data:{type,id,attributes}} PATCH body", async () => {
    const { client, calls } = makeClient(() => new Response(JSON.stringify({ data: {} }), { status: 200 }))

    await updateVersionLocalization(client, "loc-1", {
      name: "Example App",
      subtitle: "Does the thing",
      keywords: "example,app",
    })

    expect(calls[0]?.method).toBe("PATCH")
    expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/appStoreVersionLocalizations/loc-1")
    expect(calls[0]?.body).toEqual({
      data: {
        type: "appStoreVersionLocalizations",
        id: "loc-1",
        attributes: { name: "Example App", subtitle: "Does the thing", keywords: "example,app" },
      },
    })
  })

  test("createReviewSubmission posts the app relationship and returns id+state", async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(JSON.stringify({ data: { id: "rs-1", attributes: { state: "READY_FOR_REVIEW" } } }), {
          status: 201,
        }),
    )

    const submission = await createReviewSubmission(client, "app-1")

    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/reviewSubmissions")
    expect(calls[0]?.body).toEqual({
      data: {
        type: "reviewSubmissions",
        attributes: { platform: "IOS" },
        relationships: { app: { data: { type: "apps", id: "app-1" } } },
      },
    })
    expect(submission).toEqual({ id: "rs-1", state: "READY_FOR_REVIEW" })
  })

  test("submitForReview attaches the version item then flips the submission to submitted", async () => {
    const { client, calls } = makeClient((call) => {
      if (call.method === "POST") return new Response(JSON.stringify({ data: { id: "item-1" } }), { status: 201 })
      return new Response(
        JSON.stringify({ data: { id: "rs-1", attributes: { state: "WAITING_FOR_REVIEW" } } }),
        { status: 200 },
      )
    })

    const submission = await submitForReview(client, "rs-1", "ver-1")

    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/reviewSubmissionItems")
    expect(calls[0]?.body).toEqual({
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: "rs-1" } },
          appStoreVersion: { data: { type: "appStoreVersions", id: "ver-1" } },
        },
      },
    })
    expect(calls[1]?.method).toBe("PATCH")
    expect(calls[1]?.url).toBe("https://api.appstoreconnect.apple.com/v1/reviewSubmissions/rs-1")
    expect(calls[1]?.body).toEqual({
      data: { type: "reviewSubmissions", id: "rs-1", attributes: { submitted: true } },
    })
    expect(submission).toEqual({ id: "rs-1", state: "WAITING_FOR_REVIEW" })
  })

  test("getReviewState reads attributes.appStoreState", async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(JSON.stringify({ data: { id: "ver-1", attributes: { appStoreState: "IN_REVIEW" } } }), {
          status: 200,
        }),
    )

    const state = await getReviewState(client, "ver-1")

    expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/appStoreVersions/ver-1")
    expect(state).toBe("IN_REVIEW")
  })

  test("getBuildStatus filters builds by app and version and maps processingState", async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({ data: [{ id: "build-1", attributes: { version: "42", processingState: "VALID" } }] }),
          { status: 200 },
        ),
    )

    const status = await getBuildStatus(client, "app-1", "42")

    expect(calls[0]?.url).toBe("https://api.appstoreconnect.apple.com/v1/builds?filter[app]=app-1&filter[version]=42")
    expect(status).toEqual({ id: "build-1", version: "42", processingState: "VALID" })
  })

  test("getBuildStatus returns undefined when no build matches", async () => {
    const { client } = makeClient(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const status = await getBuildStatus(client, "app-1", "99")
    expect(status).toBeUndefined()
  })

  test("a 4xx from an operation surfaces as a typed AscError, not a thrown Response", async () => {
    const { client } = makeClient(
      () =>
        new Response(JSON.stringify({ errors: [{ status: "404", code: "NOT_FOUND", title: "Not Found" }] }), {
          status: 404,
        }),
    )

    let caught: unknown
    try {
      await getReviewState(client, "missing-version")
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(AscError)
    expect((caught as AscError).status).toBe(404)
    expect((caught as AscError).code).toBe("NOT_FOUND")
  })
})
