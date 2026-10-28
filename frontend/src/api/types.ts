/* Types mirror docs/api.md exactly. Timestamps are ISO-8601 strings in UTC. */

export type Params = Record<string, unknown>

export interface ApiErrorBody {
  code: string
  params: Params
}

export interface Session {
  authenticated: boolean
  username: string | null
  csrf_token: string | null
}

/* ---------- Status ---------- */

export type ICloudHealth = 'ok' | 'error' | 'unknown'
export type GoogleHealth = 'ok' | 'error' | 'reauth_required' | 'unknown'

export interface ICloudStatus {
  configured: boolean
  status: ICloudHealth
  account_masked: string | null
  last_checked_at: string | null
  error: ApiErrorBody | null
}

export interface GoogleStatus {
  configured_on_server: boolean
  connected: boolean
  status: GoogleHealth
  account: string | null
  extended_access: boolean
  last_checked_at: string | null
  error: ApiErrorBody | null
}

export interface Source {
  url: string
  id: string
  name: string
  owner: string | null
  shared: boolean
}

export interface Target {
  id: string
  name: string
  is_primary: boolean
}

export interface SyncState {
  enabled: boolean
  interval_minutes: number
  running: boolean
  current_run_id: number | null
  last_success_at: string | null
  next_run_at: string | null
}

export interface AppStatus {
  icloud: ICloudStatus
  google: GoogleStatus
  source: Source | null
  target: Target | null
  sync: SyncState
  mapped_events: number
  last_run: RunSummary | null
  recent_errors: LogEntry[]
}

/* ---------- iCloud ---------- */

export type Ownership = 'own' | 'shared' | 'unknown'
export type CalendarAccess = 'read' | 'read_write' | 'unknown'

export interface DiscoveredCalendar {
  id: string
  url: string
  name: string
  color: string | null
  description: string | null
  ownership: Ownership
  owner: string | null
  access: CalendarAccess
  privileges: string[]
  supports_events: boolean
  readable: boolean
  event_count: number | null
  error: ApiErrorBody | null
  selected: boolean
}

export interface ICloudTestResult {
  ok: boolean
  error: ApiErrorBody | null
  principal_found: boolean
  calendar_home_found: boolean
}

export type DiagnosticStepKey =
  | 'credentials'
  | 'principal'
  | 'calendar_home'
  | 'calendars'
  | 'shared_readable'
  | 'delegation'

export type DiagnosticStepStatus = 'ok' | 'warn' | 'fail' | 'skipped'

export interface DiagnosticStep {
  key: DiagnosticStepKey | (string & {})
  status: DiagnosticStepStatus
  params: Params
}

export type DiagnosticConclusion =
  | 'shared_accessible'
  | 'shared_not_listed'
  | 'shared_not_readable'
  | 'auth_failed'
  | 'unreachable'
  | 'not_configured'

export interface RawCalendarProperties {
  url: string
  resourcetype: string[]
  properties: Record<string, unknown>
}

export interface Diagnostics {
  checked_at: string
  steps: DiagnosticStep[]
  conclusion: DiagnosticConclusion | (string & {})
  calendars: DiscoveredCalendar[]
  raw: RawCalendarProperties[]
}

/* ---------- Google ---------- */

export type GoogleAccessRole = 'owner' | 'writer' | 'reader' | 'freeBusyReader'
export type GoogleLockReason = 'primary_locked' | 'not_writable' | 'scope_missing'

export interface GoogleCalendar {
  id: string
  name: string
  primary: boolean
  access_role: GoogleAccessRole
  created_by_app: boolean
  selectable: boolean
  lock_reason: GoogleLockReason | null
  selected: boolean
  color: string | null
}

export interface GoogleTestResult {
  ok: boolean
  error: ApiErrorBody | null
  account: string | null
}

/* ---------- Sync ---------- */

export interface SyncSettings {
  enabled: boolean
  interval_minutes: number
  past_months: number
  future_months: number
  deletion_dry_run: boolean
  deletion_max_absolute: number
  deletion_max_percent: number
  sync_reminders: boolean
  sync_descriptions: boolean
  default_timezone: string
  allow_primary_target: boolean
}

export type RunTrigger = 'schedule' | 'manual' | 'dry_run' | 'startup'
export type RunStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped'

export interface RunCounts {
  created: number
  updated: number
  deleted: number
  unchanged: number
  failed: number
}

export interface RunDeletions {
  planned: number
  executed: number
  blocked: boolean
  dry_run: boolean
}

export interface RunSummary {
  id: number
  trigger: RunTrigger
  dry_run: boolean
  status: RunStatus
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  counts: RunCounts
  deletions: RunDeletions
  source_events: number | null
  message: ApiErrorBody | null
}

export type RunItemAction = 'create' | 'update' | 'delete' | 'reset_instance' | 'skip_delete' | 'error'

export interface RunItem {
  action: RunItemAction
  title: string | null
  start: string | null
  recurrence_id: string | null
  planned_only: boolean
  error: ApiErrorBody | null
}

export interface RunDetail extends RunSummary {
  items: RunItem[]
}

export interface SyncRunState {
  running: boolean
  current_run_id: number | null
  next_run_at: string | null
}

export interface Paged<T> {
  items: T[]
  total: number
}

/* ---------- Logs & diagnostics ---------- */

export type LogLevel = 'info' | 'warning' | 'error'
export type LogCategory = 'sync' | 'icloud' | 'google' | 'auth' | 'system'

export interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  category: LogCategory
  code: string
  params: Params
}

export interface TechnicalDiagnostics {
  app_version: string
  python_version: string
  base_url: string
  redirect_uri: string
  database: { ok: boolean; migration: string | null }
  scheduler: { running: boolean; next_run_at: string | null; job_count: number }
  secrets: { encryption_key: boolean; google_client: boolean; admin_password: boolean }
  secure_cookies: boolean
  server_time: string
}

export interface StatsDay {
  date: string
  runs: number
  failed_runs: number
  created: number
  updated: number
  deleted: number
}

export interface Stats {
  days: StatsDay[]
}
