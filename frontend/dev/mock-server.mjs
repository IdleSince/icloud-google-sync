// Dev-only mock of the backend API (docs/api.md) so the UI can be developed and
// screenshotted without the Python server. Plain node:http, no dependencies.
// Not part of the production bundle (outside src/, never imported).
//
//   node dev/mock-server.mjs                 → configured account: 4 calendars shared by a
//                                              fake "anna@example.com", 3 of them paired,
//                                              one guard tripped
//   MOCK_SCENARIO=fresh node dev/mock-server.mjs → nothing set up yet
//   MOCK_AUTH=0 …                            → start logged out (login page)
//
// All names and addresses are made up.

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const PORT = Number(process.env.MOCK_PORT ?? 8000)
const fresh = process.env.MOCK_SCENARIO === 'fresh'

const now = () => new Date()
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
const minutes = (n) => iso(new Date(Date.now() + n * 60_000))

const OWNER = 'mailto:anna@example.com'
const CALDAV = 'https://p68-caldav.icloud.com/123/calendars'

const state = {
  session: process.env.MOCK_AUTH === '0' ? null : { username: 'admin', csrf: randomUUID() },
  icloud: fresh
    ? { configured: false, status: 'unknown', account_masked: null, last_checked_at: null, error: null }
    : { configured: true, status: 'ok', account_masked: 'jo***@icloud.com', last_checked_at: minutes(-4), error: null },
  google: fresh
    ? { configured_on_server: true, connected: false, status: 'unknown', account: null, extended_access: false, last_checked_at: null, error: null }
    : { configured_on_server: true, connected: true, status: 'ok', account: 'jonas.beispiel@gmail.com', extended_access: false, last_checked_at: minutes(-4), error: null },
  settings: {
    enabled: !fresh,
    interval_minutes: 5,
    past_months: 12,
    future_months: 24,
    deletion_dry_run: false,
    deletion_max_absolute: 25,
    deletion_max_percent: 30,
    sync_reminders: true,
    sync_descriptions: true,
    default_timezone: 'Europe/Berlin',
    allow_primary_target: false,
  },
  running: null, // { ids: number[], until, allowMass }
  nextRunId: 43,
  nextPairId: 4,
}

// Shared calendars first, like the backend sorts them.
const icloudCalendars = [
  { id: 'c_work', url: `${CALDAV}/WORK/`, name: 'Arbeit', color: '#1BADF8', description: null, ownership: 'shared', owner: OWNER, access: 'read', privileges: ['read'], supports_events: true, readable: true, event_count: 43, error: null },
  { id: 'c_free', url: `${CALDAV}/FREE/`, name: 'Freizeit', color: '#63DA38', description: null, ownership: 'shared', owner: OWNER, access: 'read', privileges: ['read'], supports_events: true, readable: true, event_count: 58, error: null },
  { id: 'c_foot', url: `${CALDAV}/FOOT/`, name: 'Fußball', color: '#FF9500', description: null, ownership: 'shared', owner: OWNER, access: 'read', privileges: ['read'], supports_events: true, readable: true, event_count: 31, error: null },
  { id: 'c_priv', url: `${CALDAV}/PRIV/`, name: 'Privat', color: '#CC73E1', description: null, ownership: 'shared', owner: OWNER, access: 'read', privileges: ['read'], supports_events: true, readable: true, event_count: 112, error: null },
  { id: 'c_club', url: `${CALDAV}/CLUB/`, name: 'Sportverein', color: '#A2845E', description: null, ownership: 'shared', owner: 'mailto:trainer@example.org', access: 'read', privileges: [], supports_events: true, readable: false, event_count: null, error: { code: 'icloud.calendar_not_readable', params: {} } },
  { id: 'c_home', url: `${CALDAV}/HOME/`, name: 'Zuhause – Projekttermine und Fristen', color: '#FF2968', description: null, ownership: 'own', owner: null, access: 'read_write', privileges: ['read', 'write'], supports_events: true, readable: true, event_count: 1342, error: null },
  { id: 'c_rem', url: `${CALDAV}/REM/`, name: 'Erinnerungen', color: '#FF9500', description: null, ownership: 'own', owner: null, access: 'read_write', privileges: ['read', 'write'], supports_events: false, readable: true, event_count: null, error: null },
]

const googleCalendars = [
  { id: 'jonas.beispiel@gmail.com', name: 'jonas.beispiel@gmail.com', primary: true, access_role: 'owner', created_by_app: false, selectable: false, lock_reason: 'primary_locked', color: '#9fe1e7' },
  { id: 'work01@group.calendar.google.com', name: 'Arbeit (anna@example.com)', primary: false, access_role: 'owner', created_by_app: true, selectable: true, lock_reason: null, color: '#9fc6e7' },
  { id: 'abc123@group.calendar.google.com', name: 'iCloud Sync', primary: false, access_role: 'owner', created_by_app: true, selectable: true, lock_reason: null, color: '#b3dc6c' },
  { id: 'holidays@group.v.calendar.google.com', name: 'Feiertage in Deutschland', primary: false, access_role: 'reader', created_by_app: false, selectable: false, lock_reason: 'not_writable', color: '#16a765' },
  { id: 'team@group.calendar.google.com', name: 'Team', primary: false, access_role: 'owner', created_by_app: false, selectable: false, lock_reason: 'scope_missing', color: '#f691b2' },
]

const ownerName = (owner) => (owner ? owner.replace(/^mailto:/i, '') : null)
const suggestedName = (cal) => (ownerName(cal.owner) ? `${cal.name} (${ownerName(cal.owner)})` : cal.name)

/** Pair = { id, enabled, url, targetId, mapped } – serialized by pairBody(). */
const pairs = fresh
  ? []
  : [
      { id: 1, enabled: true, url: `${CALDAV}/WORK/`, targetId: 'work01@group.calendar.google.com', mapped: 43 },
      { id: 2, enabled: true, url: `${CALDAV}/FREE/`, targetId: null, mapped: 0 },
      { id: 3, enabled: false, url: `${CALDAV}/FOOT/`, targetId: null, mapped: 0 },
    ]

function makeRun(id, offsetMin, pair, overrides = {}) {
  const started = new Date(Date.now() + offsetMin * 60_000)
  const duration = 900 + ((id * 373) % 2600)
  const cal = pair ? icloudCalendars.find((c) => c.url === pair.url) : null
  return {
    id,
    pair_id: pair?.id ?? null,
    calendar_name: cal?.name ?? null,
    trigger: 'schedule',
    dry_run: false,
    status: 'success',
    started_at: iso(started),
    finished_at: iso(new Date(started.getTime() + duration)),
    duration_ms: duration,
    counts: { created: id % 3, updated: id % 4, deleted: id % 5 === 0 ? 1 : 0, unchanged: 40, failed: 0 },
    deletions: { planned: 0, executed: 0, blocked: false, dry_run: false },
    source_events: cal?.event_count ?? 0,
    message: { code: 'sync.success', params: {} },
    ...overrides,
  }
}

// Only pair 1 has a target, so only it has run so far.
const workPair = pairs[0]
const runs = fresh
  ? []
  : [
      makeRun(42, -3, workPair, {
        status: 'skipped',
        counts: { created: 0, updated: 0, deleted: 0, unchanged: 43, failed: 0 },
        deletions: { planned: 31, executed: 0, blocked: true, dry_run: false },
        message: { code: 'sync.deletion_guard_tripped', params: { planned: 31, max_absolute: 25 } },
      }),
      makeRun(41, -8, workPair, { status: 'partial', counts: { created: 2, updated: 1, deleted: 0, unchanged: 38, failed: 2 }, message: { code: 'sync.partial_failure', params: {} } }),
      makeRun(40, -13, workPair, { trigger: 'manual' }),
      makeRun(39, -18, workPair, { status: 'failed', counts: { created: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0 }, message: { code: 'icloud.unreachable', params: {} } }),
      makeRun(38, -23, workPair, { trigger: 'dry_run', dry_run: true }),
      ...Array.from({ length: 30 }, (_, i) => makeRun(37 - i, -28 - i * 5, workPair)),
      // A run of a pair that was removed later: pair_id is gone, the name stays.
      makeRun(7, -200, null, { calendar_name: 'Familie (alt)' }),
    ]

const runItems = (run) =>
  run.message?.code === 'sync.deletion_guard_tripped'
    ? Array.from({ length: 6 }, (_, i) => ({ action: 'skip_delete', title: ['Teammeeting', 'Kundentermin', 'Quartalsplanung', 'Messe', 'Jour fixe', 'Betriebsausflug'][i], start: i === 5 ? '2026-12-27' : minutes(60 * 24 * (i + 1)), recurrence_id: i === 4 ? '20261110T080000Z' : null, planned_only: true, error: null }))
    : [
        { action: 'create', title: 'Teammeeting', start: '2026-11-02T08:00:00Z', recurrence_id: null, planned_only: run.dry_run, error: null },
        { action: 'update', title: 'Kundentermin', start: '2026-11-05T13:30:00Z', recurrence_id: null, planned_only: run.dry_run, error: null },
        { action: 'reset_instance', title: 'Jour fixe', start: '2026-11-10T08:00:00Z', recurrence_id: '20261110T080000Z', planned_only: false, error: null },
        { action: 'error', title: 'Weihnachtsfeier', start: '2026-12-19', recurrence_id: null, planned_only: false, error: { code: 'google.api_error', params: { status: 400 } } },
      ]

const levels = ['info', 'info', 'warning', 'error']
const cats = ['sync', 'icloud', 'google', 'auth', 'system']
const logCodes = ['sync.success', 'sync.unchanged', 'sync.partial_failure', 'icloud.unreachable', 'google.rate_limited', 'auth.invalid_credentials', 'sync.deletion_guard_tripped']
const logs = Array.from({ length: 87 }, (_, i) => {
  const level = i === 0 ? 'warning' : levels[i % levels.length]
  const code = i === 0 ? 'sync.deletion_guard_tripped' : level === 'error' ? ['icloud.unreachable', 'google.api_error', 'sync.failed'][i % 3] : logCodes[i % logCodes.length]
  const params = code === 'google.api_error' ? { status: 503 } : code.startsWith('sync.') ? { pair_id: 1 } : {}
  return { id: 1000 - i, ts: minutes(-3 - i * 7), level, category: cats[i % cats.length], code, params }
})
if (!fresh) logs.splice(1, 0, { id: 1001, ts: minutes(-2), level: 'info', category: 'sync', code: 'pair.disabled', params: { pair_id: 3 } })

function addLog(level, category, code, params = {}) {
  logs.unshift({ id: (logs[0]?.id ?? 1000) + 1, ts: iso(now()), level, category, code, params })
}

const lastRunOf = (pairId) => runs.find((r) => r.pair_id === pairId) ?? null

function pairBody(p) {
  const cal = icloudCalendars.find((c) => c.url === p.url)
  const target = googleCalendars.find((c) => c.id === p.targetId)
  return {
    id: p.id,
    enabled: p.enabled,
    source: { url: cal.url, id: cal.id, name: cal.name, owner: ownerName(cal.owner), shared: cal.ownership === 'shared' },
    target: target ? { id: target.id, name: target.name, is_primary: target.primary } : null,
    suggested_target_name: suggestedName(cal),
    last_success_at: runs.find((r) => r.pair_id === p.id && r.status === 'success')?.finished_at ?? null,
    mapped_events: p.mapped,
    last_run: lastRunOf(p.id),
  }
}

function isRunning() {
  const running = Boolean(state.running && Date.now() < state.running.until)
  if (state.running && !running) finishRuns()
  return running
}

function statusBody() {
  const running = isRunning()
  return {
    icloud: state.icloud,
    google: state.google,
    pairs: pairs.map(pairBody),
    sync: {
      enabled: state.settings.enabled,
      interval_minutes: state.settings.interval_minutes,
      running,
      current_run_id: running ? state.running.ids[0] : null,
      last_success_at: runs.find((r) => r.status === 'success')?.finished_at ?? null,
      next_run_at: state.settings.enabled ? minutes(2) : null,
    },
    mapped_events: pairs.reduce((n, p) => n + p.mapped, 0),
    last_run: runs[0] ?? null,
    recent_errors: logs.filter((l) => l.level === 'error').slice(0, 3),
  }
}

function finishRuns() {
  for (const id of state.running.ids) {
    const run = runs.find((r) => r.id === id)
    if (!run || run.status !== 'running') continue
    const pair = pairs.find((p) => p.id === run.pair_id)
    const deleted = state.running.allowMass ? (run.pair_id === 1 ? 31 : 0) : 0
    run.status = 'success'
    run.finished_at = iso(now())
    run.duration_ms = 4000
    run.counts = { created: 1, updated: 2, deleted, unchanged: 40, failed: 0 }
    run.deletions = { planned: deleted, executed: run.dry_run ? 0 : deleted, blocked: false, dry_run: run.dry_run }
    run.message = { code: 'sync.success', params: {} }
    if (pair && !run.dry_run && pair.mapped === 0) pair.mapped = icloudCalendars.find((c) => c.url === pair.url)?.event_count ?? 0
  }
  state.running = null
}

function createGoogleCalendar(name) {
  const cal = { id: `${randomUUID().slice(0, 8)}@group.calendar.google.com`, name, primary: false, access_role: 'owner', created_by_app: true, selectable: true, lock_reason: null, color: '#9fc6e7' }
  googleCalendars.push(cal)
  addLog('info', 'google', 'google.calendar_created')
  return cal
}

const err = (res, status, code, params = {}) => send(res, status, { error: { code, params } })
function send(res, status, body) {
  if (status === 204) {
    res.writeHead(204)
    return res.end()
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const p = url.pathname
  const m = req.method ?? 'GET'
  const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? await readBody(req) : {}
  // small artificial latency so loading states are visible
  await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY ?? 120)))
  console.log(m, url.pathname + url.search)

  if (p === '/api/health') return send(res, 200, { status: 'ok' })
  if (p === '/api/auth/session' && m === 'GET')
    return send(res, 200, state.session ? { authenticated: true, username: state.session.username, csrf_token: state.session.csrf } : { authenticated: false, username: null, csrf_token: null })
  if (p === '/api/auth/login' && m === 'POST') {
    if (body.username === 'admin' && body.password === 'admin') {
      state.session = { username: 'admin', csrf: randomUUID() }
      return send(res, 200, { authenticated: true, username: 'admin', csrf_token: state.session.csrf })
    }
    if (body.username === 'limit') return err(res, 429, 'auth.rate_limited', { retry_after_seconds: 42 })
    return err(res, 401, 'auth.invalid_credentials')
  }

  if (!state.session) return err(res, 401, 'auth.required')
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m) && req.headers['x-csrf-token'] !== state.session.csrf) return err(res, 403, 'auth.csrf_invalid')

  if (p === '/api/auth/logout' && m === 'POST') {
    state.session = null
    return send(res, 204)
  }
  if (p === '/api/status') return send(res, 200, statusBody())

  // iCloud
  if (p === '/api/icloud/credentials' && m === 'PUT') {
    if (!/^[a-z]{4}(-[a-z]{4}){3}$/.test(body.app_password ?? '')) return err(res, 422, 'icloud.invalid_app_password_format')
    if (body.app_password === 'aaaa-aaaa-aaaa-aaaa') return err(res, 400, 'icloud.auth_failed')
    const [u, d] = String(body.apple_id).split('@')
    state.icloud = { configured: true, status: 'ok', account_masked: `${u.slice(0, 2)}***@${d}`, last_checked_at: iso(now()), error: null }
    return send(res, 200, state.icloud)
  }
  if (p === '/api/icloud/credentials' && m === 'DELETE') {
    // Pairs are kept (docs/api.md).
    state.icloud = { configured: false, status: 'unknown', account_masked: null, last_checked_at: null, error: null }
    return send(res, 204)
  }
  if (p === '/api/icloud/test') {
    if (!state.icloud.configured) return err(res, 409, 'icloud.not_configured')
    state.icloud.last_checked_at = iso(now())
    return send(res, 200, { ok: true, error: null, principal_found: true, calendar_home_found: true })
  }
  if (p === '/api/icloud/calendars') {
    if (!state.icloud.configured) return err(res, 409, 'icloud.not_configured')
    return send(res, 200, { calendars: icloudCalendars.map((c) => ({ ...c, pair_id: pairs.find((x) => x.url === c.url)?.id ?? null })) })
  }
  if (p === '/api/icloud/diagnostics') {
    const notListed = process.env.MOCK_DIAG === 'not_listed'
    return send(res, 200, {
      checked_at: iso(now()),
      steps: [
        { key: 'credentials', status: state.icloud.configured ? 'ok' : 'fail', params: {} },
        { key: 'principal', status: 'ok', params: {} },
        { key: 'calendar_home', status: 'ok', params: {} },
        { key: 'calendars', status: notListed ? 'warn' : 'ok', params: notListed ? { total: 2, own: 2, shared: 0 } : { total: 7, own: 2, shared: 5 } },
        { key: 'shared_readable', status: notListed ? 'fail' : 'warn', params: notListed ? { readable: 0, shared: 0 } : { readable: 4, shared: 5 } },
        { key: 'delegation', status: 'skipped', params: { read_for: 0, write_for: 0 } },
      ],
      conclusion: notListed ? 'shared_not_listed' : 'shared_accessible',
      calendars: icloudCalendars.map((c) => ({ ...c, pair_id: pairs.find((x) => x.url === c.url)?.id ?? null })),
      raw: icloudCalendars.slice(0, 2).map((c) => ({ url: c.url, resourcetype: ['collection', 'calendar', ...(c.ownership === 'shared' ? ['shared'] : [])], properties: { displayname: c.name, 'calendar-color': c.color, 'current-user-privilege-set': c.privileges } })),
    })
  }

  // Google
  if (p === '/api/google/oauth/start' && m === 'POST') {
    return send(res, 200, { authorization_url: `/google?connected=1` })
  }
  if (p === '/api/google/test') return send(res, 200, { ok: true, error: null, account: state.google.account })
  if (p === '/api/google/calendars' && m === 'GET') {
    if (!state.google.connected) return err(res, 409, 'google.not_connected')
    return send(res, 200, {
      calendars: googleCalendars.map((c) => ({
        ...c,
        used_by_pair: pairs.find((x) => x.targetId === c.id)?.id ?? null,
        lock_reason: c.primary ? (state.settings.allow_primary_target ? null : 'primary_locked') : c.lock_reason,
        selectable: c.primary ? state.settings.allow_primary_target : c.selectable,
      })),
    })
  }
  if (p === '/api/google/connection' && m === 'DELETE') {
    state.google = { ...state.google, connected: false, status: 'unknown', account: null, extended_access: false }
    for (const pair of pairs) pair.targetId = null
    return send(res, 204)
  }

  // Pairs
  if (p === '/api/pairs' && m === 'GET') return send(res, 200, { pairs: pairs.map(pairBody) })
  if (p === '/api/pairs' && m === 'POST') {
    const cal = icloudCalendars.find((c) => c.url === body.calendar_url)
    if (!cal) return err(res, 404, 'icloud.calendar_not_found')
    if (!cal.readable) return err(res, 409, 'icloud.calendar_not_readable')
    if (!cal.supports_events) return err(res, 409, 'icloud.calendar_no_events')
    if (pairs.some((x) => x.url === cal.url)) return err(res, 409, 'pair.exists')
    const pair = { id: state.nextPairId++, enabled: true, url: cal.url, targetId: null, mapped: 0 }
    if (state.google.connected && body.create_target !== false) pair.targetId = createGoogleCalendar(suggestedName(cal)).id
    pairs.push(pair)
    addLog('info', 'icloud', 'icloud.source_selected', { pair_id: pair.id })
    return send(res, 201, { pair: pairBody(pair) })
  }
  const pairMatch = p.match(/^\/api\/pairs\/(\d+)(\/target)?$/)
  if (pairMatch) {
    const pair = pairs.find((x) => x.id === Number(pairMatch[1]))
    if (!pair) return err(res, 404, 'pair.not_found')
    const target = Boolean(pairMatch[2])
    if (!target && m === 'PATCH') {
      if (typeof body.enabled === 'boolean') {
        pair.enabled = body.enabled
        addLog('info', 'sync', body.enabled ? 'pair.enabled' : 'pair.disabled', { pair_id: pair.id })
      }
      return send(res, 200, { pair: pairBody(pair) })
    }
    if (!target && m === 'DELETE') {
      pairs.splice(pairs.indexOf(pair), 1)
      for (const run of runs) if (run.pair_id === pair.id) run.pair_id = null
      addLog('info', 'sync', 'pair.removed', { pair_id: pair.id })
      return send(res, 204)
    }
    if (target && m === 'PUT') {
      if (!state.google.connected) return err(res, 409, 'google.not_connected')
      const cal = googleCalendars.find((c) => c.id === body.calendar_id)
      if (!cal) return err(res, 404, 'google.calendar_not_found')
      if (pairs.some((x) => x.id !== pair.id && x.targetId === cal.id)) return err(res, 409, 'google.target_in_use')
      if (cal.primary && (!state.settings.allow_primary_target || !body.confirm_primary)) return err(res, 409, 'google.primary_locked')
      if (!cal.primary && !cal.selectable) return err(res, 409, cal.lock_reason === 'scope_missing' ? 'google.scope_missing' : 'google.calendar_not_writable')
      pair.targetId = cal.id
      addLog('info', 'google', 'google.target_selected', { pair_id: pair.id })
      return send(res, 200, { pair: pairBody(pair) })
    }
    if (target && m === 'POST') {
      if (!state.google.connected) return err(res, 409, 'google.not_connected')
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : pairBody(pair).suggested_target_name
      pair.targetId = createGoogleCalendar(name).id
      return send(res, 200, { pair: pairBody(pair) })
    }
  }

  // Sync
  if (p === '/api/sync/settings' && m === 'GET') return send(res, 200, state.settings)
  if (p === '/api/sync/settings' && m === 'PUT') {
    const bad = Object.entries(body).filter(([k, v]) => k === 'interval_minutes' && (v < 1 || v > 1440)).map(([k]) => k)
    if (bad.length) return err(res, 422, 'validation.invalid', { fields: bad })
    Object.assign(state.settings, body)
    return send(res, 200, state.settings)
  }
  if (p === '/api/sync/runs' && m === 'POST') {
    if (isRunning()) return err(res, 409, 'sync.already_running')
    let selected
    if (body.pair_id !== undefined) {
      const pair = pairs.find((x) => x.id === body.pair_id)
      if (!pair) return err(res, 404, 'pair.not_found')
      selected = pair.targetId ? [pair] : []
    } else {
      selected = pairs.filter((x) => x.enabled && x.targetId)
    }
    if (selected.length === 0) return err(res, 409, 'sync.not_configured')
    const ids = selected.map((pair) => {
      const id = state.nextRunId++
      runs.unshift({ ...makeRun(id, 0, pair), trigger: body.dry_run ? 'dry_run' : 'manual', dry_run: Boolean(body.dry_run), status: 'running', finished_at: null, duration_ms: null, message: null })
      return id
    })
    state.running = { ids, until: Date.now() + 4000, allowMass: Boolean(body.allow_mass_deletion) }
    return send(res, 202, { run_id: ids[0], run_ids: ids })
  }
  if (p === '/api/sync/runs' && m === 'GET') {
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 25))
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const status = url.searchParams.get('status')
    const filtered = status ? runs.filter((r) => r.status === status) : runs
    return send(res, 200, { items: filtered.slice(offset, offset + limit), total: filtered.length })
  }
  const runMatch = p.match(/^\/api\/sync\/runs\/(\d+)$/)
  if (runMatch) {
    const run = runs.find((r) => r.id === Number(runMatch[1]))
    if (!run) return err(res, 404, 'internal.error')
    return send(res, 200, { ...run, items: runItems(run) })
  }
  if (p === '/api/sync/state') {
    const s = statusBody().sync
    return send(res, 200, { running: s.running, current_run_id: s.current_run_id, next_run_at: s.next_run_at })
  }

  // Logs & diagnostics
  if (p === '/api/logs') {
    const level = url.searchParams.get('level')
    const category = url.searchParams.get('category')
    const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50))
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const filtered = logs.filter((l) => (!level || l.level === level) && (!category || l.category === category))
    return send(res, 200, { items: filtered.slice(offset, offset + limit), total: filtered.length })
  }
  if (p === '/api/diagnostics')
    return send(res, 200, {
      app_version: '1.0.0',
      python_version: '3.13.5',
      base_url: 'https://calsync.example.org',
      redirect_uri: 'https://calsync.example.org/api/google/oauth/callback',
      database: { ok: true, migration: '0001_initial' },
      scheduler: { running: true, next_run_at: minutes(2), job_count: 1 },
      secrets: { encryption_key: true, google_client: true, admin_password: true },
      secure_cookies: false,
      server_time: iso(now()),
    })
  if (p === '/api/stats') {
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 30)))
    return send(res, 200, {
      days: Array.from({ length: days }, (_, i) => {
        const d = new Date(Date.now() - (days - 1 - i) * 86_400_000)
        const seed = (i * 7919) % 23
        return { date: d.toISOString().slice(0, 10), runs: 288, failed_runs: seed % 9 === 0 ? 2 : 0, created: seed % 6, updated: seed % 9, deleted: seed % 13 === 0 ? 3 : seed % 4 === 0 ? 1 : 0 }
      }),
    })
  }

  return err(res, 404, 'internal.error')
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock API on http://127.0.0.1:${PORT} (scenario: ${fresh ? 'fresh' : 'configured'})`))
