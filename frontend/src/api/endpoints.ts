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
  RunDetail,
  RunStatus,
  RunSummary,
  Session,
  Source,
  Stats,
  SyncRunState,
  SyncSettings,
  Target,
  TechnicalDiagnostics,
} from './types'

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
    setSource: (calendar_url: string) => http.put<{ source: Source }>('/api/icloud/source', { calendar_url }),
  },

  google: {
    startOAuth: (extended: boolean) =>
      http.post<{ authorization_url: string }>('/api/google/oauth/start', { extended }),
    test: () => http.post<GoogleTestResult>('/api/google/test'),
    calendars: () => http.get<{ calendars: GoogleCalendar[] }>('/api/google/calendars'),
    createCalendar: (name: string, select: boolean) =>
      http.post<{ calendar: GoogleCalendar }>('/api/google/calendars', { name, select }),
    setTarget: (calendar_id: string, confirm_primary: boolean) =>
      http.put<{ target: Target }>('/api/google/target', { calendar_id, confirm_primary }),
    disconnect: () => http.del<void>('/api/google/connection'),
  },

  sync: {
    settings: () => http.get<SyncSettings>('/api/sync/settings'),
    saveSettings: (patch: Partial<SyncSettings>) => http.put<SyncSettings>('/api/sync/settings', patch),
    startRun: (dry_run: boolean, allow_mass_deletion: boolean) =>
      http.post<{ run_id: number }>('/api/sync/runs', { dry_run, allow_mass_deletion }),
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
  syncSettings: ['sync', 'settings'] as const,
  runs: (filter: string, page: number) => ['sync', 'runs', filter, page] as const,
  runsAll: ['sync', 'runs'] as const,
  run: (id: number) => ['sync', 'run', id] as const,
  logs: (level: string, category: string, page: number) => ['logs', level, category, page] as const,
  logsAll: ['logs'] as const,
  diagnostics: ['diagnostics'] as const,
  stats: (days: number) => ['stats', days] as const,
}
