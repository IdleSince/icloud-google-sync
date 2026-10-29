import { http } from './client'
import type {
  AppStatus,
  Diagnostics,
  DiscoveredCalendar,
  GoogleCalendar,
  GoogleTestResult,
  ICloudStatus,
  ICloudTestResult,
  LogCategory,
  LogEntry,
  LogLevel,
  Paged,
  Pair,
  RunDetail,
  RunStatus,
  RunSummary,
  Session,
  Stats,
  SyncRunState,
  SyncSettings,
  TechnicalDiagnostics,
} from './types'

const pairPath = (id: number) => `/api/pairs/${encodeURIComponent(String(id))}`

export const api = {
  auth: {
    session: () => http.get<Session>('/api/auth/session', { skipAuthRedirect: true }),
    login: (username: string, password: string) =>
      http.post<Session>('/api/auth/login', { username, password }, { skipAuthRedirect: true }),
    logout: () => http.post<void>('/api/auth/logout', undefined, { skipAuthRedirect: true }),
  },

  status: () => http.get<AppStatus>('/api/status'),

  icloud: {
    saveCredentials: (apple_id: string, app_password: string) =>
      http.put<ICloudStatus>('/api/icloud/credentials', { apple_id, app_password }),
    deleteCredentials: () => http.del<void>('/api/icloud/credentials'),
    test: () => http.post<ICloudTestResult>('/api/icloud/test'),
    calendars: () => http.get<{ calendars: DiscoveredCalendar[] }>('/api/icloud/calendars'),
    diagnostics: () => http.get<Diagnostics>('/api/icloud/diagnostics'),
  },

  google: {
    startOAuth: (extended: boolean) =>
      http.post<{ authorization_url: string }>('/api/google/oauth/start', { extended }),
    test: () => http.post<GoogleTestResult>('/api/google/test'),
    calendars: () => http.get<{ calendars: GoogleCalendar[] }>('/api/google/calendars'),
    disconnect: () => http.del<void>('/api/google/connection'),
  },

  pairs: {
    list: () => http.get<{ pairs: Pair[] }>('/api/pairs'),
    /** When Google is connected, the backend also creates the target calendar. */
    create: (calendar_url: string) => http.post<{ pair: Pair }>('/api/pairs', { calendar_url, create_target: true }),
    setEnabled: (id: number, enabled: boolean) => http.patch<{ pair: Pair }>(pairPath(id), { enabled }),
    remove: (id: number) => http.del<void>(pairPath(id)),
    setTarget: (id: number, calendar_id: string, confirm_primary: boolean) =>
      http.put<{ pair: Pair }>(`${pairPath(id)}/target`, { calendar_id, confirm_primary }),
    createTarget: (id: number, name?: string) => http.post<{ pair: Pair }>(`${pairPath(id)}/target`, name ? { name } : {}),
  },

  sync: {
    settings: () => http.get<SyncSettings>('/api/sync/settings'),
    saveSettings: (patch: Partial<SyncSettings>) => http.put<SyncSettings>('/api/sync/settings', patch),
    /** One run per pair: all enabled pairs, or only `pair_id`. */
    startRun: (dry_run: boolean, allow_mass_deletion: boolean, pair_id?: number) =>
      http.post<{ run_id: number; run_ids: number[] }>('/api/sync/runs', {
        dry_run,
        allow_mass_deletion,
        ...(pair_id === undefined ? {} : { pair_id }),
      }),
    runs: (params: { limit: number; offset: number; status?: RunStatus }) =>
      http.get<Paged<RunSummary>>('/api/sync/runs', { query: params }),
    run: (id: number) => http.get<RunDetail>(`/api/sync/runs/${encodeURIComponent(String(id))}`),
    state: () => http.get<SyncRunState>('/api/sync/state'),
  },

  logs: (params: { level?: LogLevel; category?: LogCategory; limit: number; offset: number }) =>
    http.get<Paged<LogEntry>>('/api/logs', { query: params }),
  diagnostics: () => http.get<TechnicalDiagnostics>('/api/diagnostics'),
  stats: (days: number) => http.get<Stats>('/api/stats', { query: { days } }),
}

/** Query keys in one place so invalidation stays consistent. */
export const qk = {
  session: ['session'] as const,
  status: ['status'] as const,
  icloudCalendars: ['icloud', 'calendars'] as const,
  icloudDiagnostics: ['icloud', 'diagnostics'] as const,
  googleCalendars: ['google', 'calendars'] as const,
  pairs: ['pairs'] as const,
  syncSettings: ['sync', 'settings'] as const,
  runs: (filter: string, page: number) => ['sync', 'runs', filter, page] as const,
  runsAll: ['sync', 'runs'] as const,
  run: (id: number) => ['sync', 'run', id] as const,
  logs: (level: string, category: string, page: number) => ['logs', level, category, page] as const,
  logsAll: ['logs'] as const,
  diagnostics: ['diagnostics'] as const,
  stats: (days: number) => ['stats', days] as const,
}
