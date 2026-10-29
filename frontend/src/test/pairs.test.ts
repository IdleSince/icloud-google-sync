import { afterEach, describe, expect, it } from 'vitest'
import { setCsrfToken, setFetch } from '@/api/client'
import { api } from '@/api/endpoints'
import type { AppStatus, DiscoveredCalendar, Pair, RunSummary } from '@/api/types'
import { NAV_ITEMS } from '@/components/layout/nav'
import { canSync, everyEnabledPairHasTarget, guardTrippedPairs, isPairable, pairsWithoutTarget, sharedCalendarsToAdd } from '@/lib/pairs'

const TARGET = { id: 't@group.calendar.google.com', name: 'Arbeit (anna@example.com)', is_primary: false }

function pair(id: number, overrides: Partial<Pair> = {}): Pair {
  return {
    id,
    enabled: true,
    source: { url: `https://caldav.example/${id}/`, id: `c_${id}`, name: `Cal ${id}`, owner: 'anna@example.com', shared: true },
    target: TARGET,
    suggested_target_name: `Cal ${id} (anna@example.com)`,
    last_success_at: null,
    mapped_events: 0,
    last_run: null,
    ...overrides,
  }
}

function calendar(id: string, overrides: Partial<DiscoveredCalendar> = {}): DiscoveredCalendar {
  return {
    id,
    url: `https://caldav.example/${id}/`,
    name: id,
    color: null,
    description: null,
    ownership: 'shared',
    owner: 'mailto:anna@example.com',
    access: 'read',
    privileges: ['read'],
    supports_events: true,
    readable: true,
    event_count: 3,
    error: null,
    pair_id: null,
    ...overrides,
  }
}

function run(overrides: Partial<RunSummary>): RunSummary {
  return {
    id: 1,
    pair_id: 1,
    calendar_name: 'Cal 1',
    trigger: 'schedule',
    dry_run: false,
    status: 'success',
    started_at: '2026-10-28T09:00:00Z',
    finished_at: '2026-10-28T09:00:02Z',
    duration_ms: 2000,
    counts: { created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0 },
    deletions: { planned: 0, executed: 0, blocked: false, dry_run: false },
    source_events: 0,
    message: { code: 'sync.success', params: {} },
    ...overrides,
  }
}

describe('pair rules', () => {
  it('can sync only when an enabled pair has a target', () => {
    expect(canSync([])).toBe(false)
    expect(canSync([pair(1, { target: null })])).toBe(false)
    expect(canSync([pair(1, { enabled: false })])).toBe(false)
    expect(canSync([pair(1, { enabled: false }), pair(2)])).toBe(true)
  })

  it('setup is complete when every enabled pair has a target', () => {
    expect(everyEnabledPairHasTarget([])).toBe(false)
    expect(everyEnabledPairHasTarget([pair(1), pair(2, { target: null })])).toBe(false)
    // A paused pair without target does not block the setup.
    expect(everyEnabledPairHasTarget([pair(1), pair(2, { enabled: false, target: null })])).toBe(true)
  })

  it('lists pairs without target regardless of enabled state', () => {
    const list = [pair(1), pair(2, { target: null }), pair(3, { enabled: false, target: null })]
    expect(pairsWithoutTarget(list).map((p) => p.id)).toEqual([2, 3])
  })

  it('only offers readable event calendars that are not paired yet for "sync all shared"', () => {
    const list = [
      calendar('ok'),
      calendar('paired', { pair_id: 4 }),
      calendar('own', { ownership: 'own' }),
      calendar('reminders', { supports_events: false }),
      calendar('locked', { readable: false }),
    ]
    expect(sharedCalendarsToAdd(list).map((c) => c.id)).toEqual(['ok'])
    expect(isPairable(list[2]!)).toBe(true)
    expect(isPairable(list[3]!)).toBe(false)
    expect(isPairable(list[4]!)).toBe(false)
  })

  it('finds pairs whose deletion guard tripped', () => {
    const tripped = pair(2, { last_run: run({ status: 'skipped', message: { code: 'sync.deletion_guard_tripped', params: {} } }) })
    expect(guardTrippedPairs([pair(1, { last_run: run({}) }), tripped]).map((p) => p.id)).toEqual([2])
  })
})

describe('navigation badges', () => {
  const base: AppStatus = {
    icloud: { configured: true, status: 'ok', account_masked: 'jo***@icloud.com', last_checked_at: null, error: null },
    google: { configured_on_server: true, connected: true, status: 'ok', account: 'me@example.com', extended_access: false, last_checked_at: null, error: null },
    pairs: [pair(1)],
    sync: { enabled: true, interval_minutes: 5, running: false, current_run_id: null, last_success_at: null, next_run_at: null },
    mapped_events: 0,
    last_run: null,
    recent_errors: [],
  }
  const attention = (key: string, status: AppStatus) => NAV_ITEMS.find((n) => n.key === key)!.attention!(status)

  it('iCloud needs attention without any pair', () => {
    expect(attention('icloud', base)).toBe(false)
    expect(attention('icloud', { ...base, pairs: [] })).toBe(true)
  })

  it('Google needs attention when an enabled pair lacks a target', () => {
    expect(attention('google', base)).toBe(false)
    expect(attention('google', { ...base, pairs: [pair(1), pair(2, { target: null })] })).toBe(true)
    expect(attention('google', { ...base, pairs: [pair(1), pair(2, { enabled: false, target: null })] })).toBe(false)
  })

  it('Sync and Logs look at the last run of every pair', () => {
    const guard = pair(2, { last_run: run({ message: { code: 'sync.deletion_guard_tripped', params: {} } }) })
    const failed = pair(3, { last_run: run({ status: 'failed' }) })
    expect(attention('sync', { ...base, pairs: [pair(1), guard] })).toBe(true)
    expect(attention('logs', { ...base, pairs: [pair(1), failed] })).toBe(true)
    expect(attention('logs', base)).toBe(false)
  })
})

describe('pair endpoints', () => {
  afterEach(() => setCsrfToken(null))

  function capture(status = 200, body: unknown = { pair: pair(1) }) {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    setFetch(async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    })
    return calls
  }

  it('creates a pair together with its target', async () => {
    const calls = capture(201)
    await api.pairs.create('https://caldav.example/1/')
    expect(calls[0]).toEqual({ url: '/api/pairs', method: 'POST', body: { calendar_url: 'https://caldav.example/1/', create_target: true } })
  })

  it('pauses, removes and retargets a pair', async () => {
    const calls = capture()
    await api.pairs.setEnabled(3, false)
    await api.pairs.setTarget(3, 'x@group.calendar.google.com', true)
    await api.pairs.createTarget(3, 'Fußball (anna@example.com)')
    await api.pairs.createTarget(3)
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['PATCH', '/api/pairs/3', { enabled: false }],
      ['PUT', '/api/pairs/3/target', { calendar_id: 'x@group.calendar.google.com', confirm_primary: true }],
      ['POST', '/api/pairs/3/target', { name: 'Fußball (anna@example.com)' }],
      ['POST', '/api/pairs/3/target', {}],
    ])
    const del = capture(204)
    await api.pairs.remove(3)
    expect(del[0]).toMatchObject({ method: 'DELETE', url: '/api/pairs/3' })
  })

  it('starts runs for all pairs or only one', async () => {
    const calls = capture(202, { run_id: 1, run_ids: [1, 2] })
    await api.sync.startRun(false, false)
    await api.sync.startRun(false, true, 2)
    expect(calls.map((c) => c.body)).toEqual([
      { dry_run: false, allow_mass_deletion: false },
      { dry_run: false, allow_mass_deletion: true, pair_id: 2 },
    ])
  })
})
