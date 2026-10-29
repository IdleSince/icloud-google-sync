# API reference

All endpoints live under `/api`. The machine-readable OpenAPI schema is served at
`/api/openapi.json` **only after login**. There is deliberately no Swagger UI: it
would load scripts from an external CDN.

## Conventions

- JSON in, JSON out. Timestamps are ISO 8601 in UTC (`2026-10-28T09:00:00Z`).
- Authentication: session cookie (`icgs_session`, `HttpOnly`, `SameSite=Lax`,
  `Secure` when `APP_BASE_URL` is https).
- Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must send the
  header `X-CSRF-Token` with the token returned by `GET /api/auth/session`.
- Errors never contain human-readable text. They return a machine code that the
  frontend translates:

  ```json
  { "error": { "code": "icloud.auth_failed", "params": {} } }
  ```

- Public endpoints: `GET /api/health`, `GET /api/auth/session`,
  `POST /api/auth/login`, `GET /api/google/oauth/callback` (state protected).
  Everything else requires a valid session (401 `auth.required`).

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `auth.required` | 401 | Not logged in |
| `auth.invalid_credentials` | 401 | Wrong username or password |
| `auth.rate_limited` | 429 | Too many failed logins, `params.retry_after_seconds` |
| `auth.csrf_invalid` | 403 | Missing/invalid CSRF token |
| `validation.invalid` | 422 | Invalid input, `params.fields: string[]` |
| `icloud.not_configured` | 409 | No Apple ID / app password stored |
| `icloud.auth_failed` | 400 | Apple rejected the credentials |
| `icloud.unreachable` | 502 | iCloud CalDAV not reachable (network/timeout) |
| `icloud.unexpected_response` | 502 | iCloud answered with something unparsable |
| `icloud.invalid_apple_id` | 422 | Apple ID is not an e-mail address |
| `icloud.invalid_app_password_format` | 422 | App password is not `xxxx-xxxx-xxxx-xxxx` |
| `icloud.calendar_not_found` | 404 | Calendar URL is not among the discovered calendars |
| `icloud.calendar_not_readable` | 409 | Calendar exists but cannot be read |
| `icloud.calendar_no_events` | 409 | Calendar does not support events (e.g. reminders list) |
| `google.not_configured` | 409 | `GOOGLE_CLIENT_ID` / secret missing on the server |
| `google.not_connected` | 409 | No Google account connected |
| `google.reauth_required` | 409 | Refresh token revoked/expired, reconnect needed |
| `google.oauth_state_invalid` | 400 | OAuth state missing, expired or reused |
| `google.oauth_denied` | 400 | User cancelled the consent screen |
| `google.oauth_failed` | 502 | Token exchange failed |
| `google.scope_missing` | 403 | Operation needs the extended scope (`calendar.events.owned`) |
| `google.api_error` | 502 | Google API returned an error, `params.status` |
| `google.rate_limited` | 429 | Google rate limit, retries exhausted |
| `google.calendar_not_found` | 404 | Target calendar does not exist / not accessible |
| `google.calendar_not_writable` | 409 | Calendar is read-only for this account |
| `google.primary_locked` | 409 | Primary calendar selected without unlocking it |
| `google.target_in_use` | 409 | That Google calendar already belongs to another pair |
| `pair.not_found` | 404 | Unknown pair id |
| `pair.exists` | 409 | This iCloud calendar is already synchronized |
| `sync.not_configured` | 409 | No pair with a target calendar (or the given pair has none) |
| `sync.already_running` | 409 | A run is already in progress |
| `internal.error` | 500 | Unexpected error (details only in the server log) |

Codes that only appear inside run results / logs (`message.code`):
`sync.success`, `sync.unchanged`, `sync.partial_failure`, `sync.failed`,
`sync.source_incomplete`, `sync.deletion_guard_tripped`,
`sync.deletion_dry_run`, `sync.not_configured`, `sync.cancelled`, plus any of
the `icloud.*` / `google.*` codes above.

Informational log codes (`LogEntry.code`, level `info`): `auth.login`,
`system.started`, `system.stopped`, `settings.updated`,
`icloud.credentials_saved`, `icloud.credentials_removed`, `icloud.source_selected`,
`icloud.diagnosis.<conclusion>` (see `Diagnostics.conclusion`), `google.connected`,
`google.disconnected`, `google.calendar_created`, `google.target_selected`,
`pair.enabled`, `pair.disabled`, `pair.removed`. Codes that concern one pair carry `params.pair_id`.
Warnings/errors in the log reuse the error codes above.

## Auth

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/auth/session` | – | `{ authenticated: bool, username: string\|null, csrf_token: string\|null }` |
| POST | `/api/auth/login` | `{ username, password }` | same as session |
| POST | `/api/auth/logout` | – | `204` |

Login does **not** require a CSRF token (there is no session yet); it is protected by
`SameSite`, origin check and rate limiting.

## Health & status

`GET /api/health` → `{ "status": "ok" }` (public, used by Docker healthcheck).

`GET /api/status`

```json
{
  "icloud": {
    "configured": true,
    "status": "ok | error | unknown",
    "account_masked": "jo***@icloud.com",
    "last_checked_at": "…",
    "error": { "code": "icloud.auth_failed", "params": {} } | null
  },
  "google": {
    "configured_on_server": true,
    "connected": true,
    "status": "ok | error | reauth_required | unknown",
    "account": "me@gmail.com" | null,
    "extended_access": false,
    "last_checked_at": "…",
    "error": null
  },
  "pairs": [ Pair, … ],
  "sync": {
    "enabled": true,
    "interval_minutes": 5,
    "running": false,
    "current_run_id": null,
    "last_success_at": "…" | null,
    "next_run_at": "…" | null
  },
  "mapped_events": 132,                  // sum over all pairs
  "last_run": RunSummary | null,         // newest run of any pair
  "recent_errors": [ LogEntry, … ]       // max 5, newest first
}
```

## iCloud

| Method | Path | Body | Response |
|---|---|---|---|
| PUT | `/api/icloud/credentials` | `{ apple_id, app_password }` | `ICloudStatus` (credentials are tested before they are stored) |
| DELETE | `/api/icloud/credentials` | – | `204` (pairs are kept) |
| POST | `/api/icloud/test` | – | `{ ok: bool, error: Error\|null, principal_found: bool, calendar_home_found: bool }` |
| GET | `/api/icloud/calendars` | – | `{ calendars: DiscoveredCalendar[] }` |
| GET | `/api/icloud/diagnostics` | – | `Diagnostics` |

`DiscoveredCalendar`

```json
{
  "id": "c_3f9a…",                  // stable: hash of the CalDAV URL
  "url": "https://p68-caldav.icloud.com/123/calendars/ABC/",
  "name": "Familie",
  "color": "#FF2968" | null,
  "description": null,
  "ownership": "own | shared | unknown",
  "owner": "Anna Beispiel" | null,  // display name or mailto: of the sharer
  "access": "read | read_write | unknown",
  "privileges": ["read", "write", …],
  "supports_events": true,
  "readable": true,
  "event_count": 214 | null,
  "error": Error | null,
  "pair_id": 3 | null               // pair that syncs this calendar
}
```

`Diagnostics`

```json
{
  "checked_at": "…",
  "steps": [
    { "key": "credentials", "status": "ok | warn | fail | skipped", "params": {} },
    { "key": "principal",   "status": "ok", "params": {} },
    { "key": "calendar_home", "status": "ok", "params": {} },
    { "key": "calendars",   "status": "ok", "params": { "total": 5, "own": 4, "shared": 1 } },
    { "key": "shared_readable", "status": "ok | warn | fail", "params": { "readable": 1, "shared": 1 } },
    { "key": "delegation",  "status": "ok | skipped", "params": { "read_for": 0, "write_for": 0 } }
  ],
  "conclusion": "shared_accessible | shared_not_listed | shared_not_readable | auth_failed | unreachable | not_configured",
  "calendars": [ DiscoveredCalendar, … ],
  "raw": [ { "url": "…", "resourcetype": ["collection","calendar","shared"], "properties": { "…": "…" } } ]
}
```

`raw` contains the sanitized CalDAV properties per calendar (no event data, no
credentials) for technical troubleshooting.

## Google

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/google/oauth/start` | `{ extended: bool }` | `{ authorization_url }` – the browser navigates there |
| GET | `/api/google/oauth/callback` | query `code`, `state` | `302` → `/google?connected=1` or `/google?error=<code>` |
| POST | `/api/google/test` | – | `{ ok, error, account }` |
| GET | `/api/google/calendars` | – | `{ calendars: GoogleCalendar[] }` |
| DELETE | `/api/google/connection` | – | `204` (token revoked at Google, then deleted; all pairs lose their target) |

`GoogleCalendar`

```json
{
  "id": "…@group.calendar.google.com",
  "name": "iCloud Sync",
  "primary": false,
  "access_role": "owner | writer | reader | freeBusyReader",
  "created_by_app": true,
  "selectable": true,
  "lock_reason": null | "primary_locked" | "not_writable" | "scope_missing",
  "used_by_pair": 3 | null,
  "color": "#9fc6e7" | null
}
```

## Pairs

Every synchronized iCloud calendar is a *pair*: one iCloud calendar → one Google
calendar. A Google calendar can belong to one pair only (`google.target_in_use`).

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/pairs` | – | `{ pairs: Pair[] }` (oldest first) |
| POST | `/api/pairs` | `{ calendar_url, create_target?: true }` | `201 { pair: Pair }`; when Google is connected a Google calendar named `suggested_target_name` is created and selected |
| PATCH | `/api/pairs/{id}` | `{ enabled?: bool }` | `{ pair: Pair }` |
| DELETE | `/api/pairs/{id}` | – | `204`; stops syncing, nothing is deleted in Google or iCloud, run history stays |
| PUT | `/api/pairs/{id}/target` | `{ calendar_id, confirm_primary?: false }` | `{ pair: Pair }` |
| POST | `/api/pairs/{id}/target` | `{ name?: string }` | `{ pair: Pair }` – creates a new Google calendar (default `suggested_target_name`) |

`Pair`

```json
{
  "id": 3,
  "enabled": true,
  "source": { "url": "…", "id": "c_ab12…", "name": "Arbeit", "owner": "anna@example.com", "shared": true },
  "target": { "id": "…@group.calendar.google.com", "name": "Arbeit (anna@example.com)", "is_primary": false } | null,
  "suggested_target_name": "Arbeit (anna@example.com)",
  "last_success_at": "…" | null,
  "mapped_events": 43,
  "last_run": RunSummary | null
}
```

## Sync

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/sync/settings` | – | `SyncSettings` |
| PUT | `/api/sync/settings` | `SyncSettings` (partial allowed) | `SyncSettings` |
| POST | `/api/sync/runs` | `{ dry_run: bool, allow_mass_deletion: bool, pair_id?: int }` | `202 { run_id, run_ids }` – one run per pair (all enabled pairs, or only `pair_id`); `409 sync.already_running` |
| GET | `/api/sync/runs` | query `limit` (≤100), `offset`, `status` | `{ items: RunSummary[], total }` |
| GET | `/api/sync/runs/{id}` | – | `RunDetail` |
| GET | `/api/sync/state` | – | `{ running, current_run_id, next_run_at }` |

`SyncSettings`

```json
{
  "enabled": true,
  "interval_minutes": 5,          // 1..1440
  "past_months": 12,              // 0..120
  "future_months": 24,            // 1..120
  "deletion_dry_run": false,      // plan deletions but never execute them
  "deletion_max_absolute": 25,    // more planned deletions => blocked
  "deletion_max_percent": 30,     // percentage of mapped events => blocked
  "sync_reminders": true,
  "sync_descriptions": true,
  "default_timezone": "Europe/Berlin",   // for floating times
  "allow_primary_target": false
}
```

`RunSummary`

```json
{
  "id": 42,
  "pair_id": 3 | null,             // null after the pair was removed
  "calendar_name": "Arbeit" | null, // iCloud calendar name at run time
  "trigger": "schedule | manual | dry_run | startup",
  "dry_run": false,
  "status": "running | success | partial | failed | skipped",
  "started_at": "…", "finished_at": "…", "duration_ms": 1830,
  "counts": { "created": 1, "updated": 2, "deleted": 0, "unchanged": 129, "failed": 0 },
  "deletions": { "planned": 0, "executed": 0, "blocked": false, "dry_run": false },
  "source_events": 132,
  "message": { "code": "sync.success", "params": {} }
}
```

`RunDetail` = `RunSummary` + `items: RunItem[]`

```json
{ "action": "create | update | delete | reset_instance | skip_delete | error",
  "title": "Zahnarzt", "start": "2026-11-02T08:00:00Z" | "2026-11-02",
  "recurrence_id": null | "20261110T080000Z",
  "planned_only": false,
  "error": Error | null }
```

## Logs & diagnostics

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/logs` | `level` (`info`,`warning`,`error`), `category` (`sync`,`icloud`,`google`,`auth`,`system`), `limit` ≤200, `offset` | `{ items: LogEntry[], total }` |
| GET | `/api/diagnostics` | – | `TechnicalDiagnostics` |
| GET | `/api/stats` | query `days` (1..90, default 30) | `{ days: [{ date: "2026-10-28", runs, failed_runs, created, updated, deleted }] }` |

`LogEntry` = `{ id, ts, level, category, code, params }`

`TechnicalDiagnostics`

```json
{
  "app_version": "1.1.0",
  "python_version": "3.13.5",
  "base_url": "https://calsync.example.org",
  "redirect_uri": "https://calsync.example.org/api/google/oauth/callback",
  "database": { "ok": true, "migration": "0001_initial" },
  "scheduler": { "running": true, "next_run_at": "…", "job_count": 1 },
  "secrets": { "encryption_key": true, "google_client": true, "admin_password": true },
  "secure_cookies": true,
  "server_time": "…"
}
```
