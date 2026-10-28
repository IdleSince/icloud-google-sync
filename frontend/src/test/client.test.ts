import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, http, NETWORK_ERROR_CODE, onUnauthorized, setCsrfToken, setFetch, toApiError } from '@/api/client'

interface Captured {
  url: string
  init: RequestInit
}

function mockFetch(status: number, body?: unknown) {
  const calls: Captured[] = []
  setFetch(async (url, init) => {
    calls.push({ url, init: init ?? {} })
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
  return calls
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name]
}

afterEach(() => {
  setCsrfToken(null)
  onUnauthorized(null)
})

describe('CSRF header', () => {
  it.each(['post', 'put', 'del'] as const)('is sent on %s', async (method) => {
    setCsrfToken('tok-123')
    const calls = mockFetch(200, { ok: true })
    await (method === 'del' ? http.del('/api/x') : http[method]('/api/x', { a: 1 }))
    expect(header(calls[0]!.init, 'X-CSRF-Token')).toBe('tok-123')
  })

  it('is sent on PATCH via request()', async () => {
    const { request } = await import('@/api/client')
    setCsrfToken('tok-p')
    const calls = mockFetch(200, {})
    await request('PATCH', '/api/x', { body: {} })
    expect(header(calls[0]!.init, 'X-CSRF-Token')).toBe('tok-p')
  })

  it('is not sent on GET', async () => {
    setCsrfToken('tok-123')
    const calls = mockFetch(200, {})
    await http.get('/api/status')
    expect(header(calls[0]!.init, 'X-CSRF-Token')).toBeUndefined()
  })

  it('serializes JSON bodies and query strings', async () => {
    const calls = mockFetch(200, {})
    await http.get('/api/logs', { query: { level: 'error', category: undefined, limit: 25, offset: 0 } })
    expect(calls[0]!.url).toBe('/api/logs?level=error&limit=25&offset=0')
    await http.put('/api/sync/settings', { interval_minutes: 5 })
    expect(calls[1]!.init.body).toBe('{"interval_minutes":5}')
    expect(header(calls[1]!.init, 'Content-Type')).toBe('application/json')
  })
})

describe('error mapping', () => {
  it('maps the error envelope to a typed ApiError', async () => {
    mockFetch(400, { error: { code: 'icloud.auth_failed', params: { x: 1 } } })
    const err = await http.post('/api/icloud/test').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: 'icloud.auth_failed', params: { x: 1 } })
  })

  it('falls back to internal.error for unknown bodies', () => {
    expect(toApiError(500, '<html>')).toMatchObject({ code: 'internal.error', status: 500 })
    expect(toApiError(502, { error: 'nope' })).toMatchObject({ code: 'internal.error' })
  })

  it('maps network failures to network.unreachable', async () => {
    setFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(http.get('/api/status')).rejects.toMatchObject({ code: NETWORK_ERROR_CODE, status: 0 })
  })

  it('calls the unauthorized handler on 401 and clears the token', async () => {
    const handler = vi.fn()
    onUnauthorized(handler)
    setCsrfToken('tok')
    mockFetch(401, { error: { code: 'auth.required', params: {} } })
    await expect(http.get('/api/status')).rejects.toMatchObject({ code: 'auth.required' })
    expect(handler).toHaveBeenCalledTimes(1)
    // token cleared → next mutation carries no header
    const calls = mockFetch(200, {})
    await http.post('/api/x')
    expect(header(calls[0]!.init, 'X-CSRF-Token')).toBeUndefined()
  })

  it('does not redirect for login failures', async () => {
    const handler = vi.fn()
    onUnauthorized(handler)
    mockFetch(401, { error: { code: 'auth.invalid_credentials', params: {} } })
    await expect(http.post('/api/auth/login', {}, { skipAuthRedirect: true })).rejects.toMatchObject({ code: 'auth.invalid_credentials' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('returns undefined for 204', async () => {
    setFetch(async () => new Response(null, { status: 204 }))
    await expect(http.del('/api/google/connection')).resolves.toBeUndefined()
  })
})
