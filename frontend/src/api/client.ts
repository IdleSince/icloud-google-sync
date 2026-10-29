import type { ApiErrorBody, Params } from './types'

/** Error thrown for every non-2xx response. `code` is the machine code from the API
 *  (`icloud.auth_failed`, …) or a synthetic `network.unreachable` / `internal.error`. */
export class ApiError extends Error {
  readonly code: string
  readonly params: Params
  readonly status: number

  constructor(status: number, code: string, params: Params = {}) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.params = params
  }
}

export const NETWORK_ERROR_CODE = 'network.unreachable'
export const FALLBACK_ERROR_CODE = 'internal.error'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/* CSRF token lives in memory only — never in storage. */
let csrfToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

export function getCsrfToken(): string | null {
  return csrfToken
}

/** Called once for every 401 so the app can send the user back to the login page. */
export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

function isErrorEnvelope(value: unknown): value is { error: ApiErrorBody } {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false
  const err = (value as { error: unknown }).error
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
}

/** Maps any response body to a typed ApiError. Unknown shapes fall back to `internal.error`. */
export function toApiError(status: number, body: unknown): ApiError {
  if (isErrorEnvelope(body)) {
    const params = body.error.params
    return new ApiError(
      status,
      body.error.code,
      typeof params === 'object' && params !== null ? params : {},
    )
  }
  if (status === 401) return new ApiError(status, 'auth.required')
  return new ApiError(status, FALLBACK_ERROR_CODE)
}

export interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  /** Skip the global 401 redirect (used by the session probe and login). */
  skipAuthRedirect?: boolean
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchLike = (input, init) => fetch(input, init)

/** Test hook. */
export function setFetch(impl: FetchLike): void {
  fetchImpl = impl
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const upper = method.toUpperCase()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (MUTATING.has(upper) && csrfToken) headers['X-CSRF-Token'] = csrfToken

  let response: Response
  try {
    response = await fetchImpl(buildUrl(path, options.query), {
      method: upper,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError(0, NETWORK_ERROR_CODE)
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  const text = await response.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const error = toApiError(response.status, payload)
    if (response.status === 401 && !options.skipAuthRedirect) {
      csrfToken = null
      unauthorizedHandler?.()
    }
    throw error
  }
  return payload as T
}

export const http = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, { ...options, body }),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, { ...options, body }),
  del: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
}
