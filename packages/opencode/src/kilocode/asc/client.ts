// kilocode_change - new file
import { z } from "zod"
import type { AscCredential } from "./auth"
import { signAscJwt } from "./jwt"

const DEFAULT_BASE_URL = "https://api.appstoreconnect.apple.com"
const TOKEN_REFRESH_MARGIN_MS = 120_000 // re-mint ~2 minutes before the token's `exp`
const MAX_ATTEMPTS = 3
const INITIAL_BACKOFF_MS = 200

/** Mirrors kilo-gateway's `embedding-models.ts` retryable-status shape (408/425/429/>=500). */
const retryable = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500

const ascErrorEntry = z.object({
  status: z.string().optional(),
  code: z.string().optional(),
  title: z.string().optional(),
  detail: z.string().optional(),
})

const ascErrorEnvelope = z.object({ errors: z.array(ascErrorEntry) })

export type AscErrorEntry = z.infer<typeof ascErrorEntry>

/**
 * A typed, catchable error for a non-2xx App Store Connect API response - never a raw `Response`.
 * Mirrors ASC's `{errors:[{status,code,title,detail}]}` envelope: `status`/`code`/`title`/`detail`
 * surface the FIRST entry (ASC can return several); the full list is on `errors`.
 */
export class AscError extends Error {
  readonly status: number
  readonly code?: string
  readonly title?: string
  readonly detail?: string
  readonly errors: AscErrorEntry[]

  constructor(httpStatus: number, errors: AscErrorEntry[]) {
    const first = errors[0]
    super(first?.detail ?? first?.title ?? `App Store Connect request failed (HTTP ${httpStatus})`)
    this.name = "AscError"
    this.status = httpStatus
    this.code = first?.code
    this.title = first?.title
    this.detail = first?.detail
    this.errors = errors
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** base64url-decode a JWT's middle segment to read its `exp` claim (seconds since epoch). */
function decodeExpMs(token: string): number {
  const claimsPart = token.split(".")[1] ?? ""
  const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as { exp: number }
  return claims.exp * 1000
}

async function parseAscErrorEnvelope(response: Response): Promise<AscErrorEntry[]> {
  try {
    const body = await response.json()
    const parsed = ascErrorEnvelope.safeParse(body)
    if (parsed.success && parsed.data.errors.length > 0) return parsed.data.errors
  } catch {
    // non-JSON or unexpected shape - fall through to a synthetic single error below
  }
  return [{ status: String(response.status), title: response.statusText || undefined }]
}

type AscClientOptions = {
  credential: AscCredential
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  now?: () => number
}

type CachedToken = { value: string; expMs: number }

/**
 * Direct App Store Connect REST client. Mints an ES256 Bearer JWT via `signAscJwt` and caches it
 * until ~2 minutes before its `exp`, retries 429/5xx with capped exponential backoff, and maps
 * ASC's `{errors:[...]}` envelope on non-2xx responses to a typed, catchable `AscError`.
 *
 * SECURITY: never logs the credential or the minted token - the only strings this class ever
 * returns/throws are response bodies and `AscError` fields (status/code/title/detail), never the
 * `Authorization` header value or `credential.privateKeyPem`.
 *
 * `fetch` and `now` are injectable so callers (and tests) never make a live Apple call.
 */
export class AscClient {
  private readonly credential: AscCredential
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly baseUrl: string
  private readonly now: () => number
  private cachedToken: CachedToken | undefined

  constructor(options: AscClientOptions) {
    this.credential = options.credential
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.now = options.now ?? Date.now
  }

  private token(): string {
    const nowMs = this.now()
    if (this.cachedToken && nowMs < this.cachedToken.expMs - TOKEN_REFRESH_MARGIN_MS) {
      return this.cachedToken.value
    }
    const value = signAscJwt(this.credential, { now: nowMs })
    this.cachedToken = { value, expMs: decodeExpMs(value) }
    return value
  }

  async request<T = unknown>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })

      if (response.ok) {
        const text = await response.text()
        return (text ? JSON.parse(text) : undefined) as T
      }

      const errors = await parseAscErrorEnvelope(response)
      const error = new AscError(response.status, errors)

      if (!retryable(response.status) || attempt === MAX_ATTEMPTS - 1) throw error
      await wait(INITIAL_BACKOFF_MS * 2 ** attempt)
    }

    // unreachable - the loop above always either returns or throws
    throw new AscError(0, [])
  }

  get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path)
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body)
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body)
  }
}
