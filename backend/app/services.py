"""Glue between API, scheduler and the sync engine."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .caldav.client import CalDAVClient
from .config import get_settings
from .crypto import decrypt
from .db import session_scope
from .errors import AppError, GoogleReauthRequired, ICloudAuthError
from .google.calendar import GoogleCalendarClient
from .google.oauth import GoogleOAuth, TokenProvider
from .logging_setup import log_event
from .models import AppSettings, Credential, LogEntry, SyncRun, utcnow
from .sync.engine import RunOptions, SyncEngine
from .sync.lock import is_locked, pair_lock

log = logging.getLogger(__name__)

LOCK_NAME = "sync:default"
RETENTION = timedelta(days=90)

# Injected by tests to talk to fake servers instead of Apple/Google.
caldav_transport: httpx.BaseTransport | None = None
google_transport: httpx.BaseTransport | None = None

shutdown_event = threading.Event()
_threads: set[threading.Thread] = set()
_threads_guard = threading.Lock()
current_run_id: int | None = None


def app_settings(db: Session) -> AppSettings:
    s = db.get(AppSettings, 1)
    if s is None:
        s = AppSettings(id=1)
        db.add(s)
        db.flush()
    return s


# -- clients -----------------------------------------------------------------------------


def icloud_credentials(db: Session) -> tuple[str, str]:
    cred = db.get(Credential, "icloud")
    if cred is None or not cred.secret_enc or not cred.account_enc:
        raise AppError("icloud.not_configured", 409)
    return decrypt(cred.account_enc, "icloud.account"), decrypt(cred.secret_enc, "icloud.app_password")


def make_caldav(apple_id: str, password: str, cancel: threading.Event | None = None) -> CalDAVClient:
    s = get_settings()
    return CalDAVClient(
        apple_id, password, base_url=s.icloud_caldav_url, allowed_host_suffix=s.icloud_allowed_host_suffix, transport=caldav_transport, cancel=cancel
    )


def make_oauth() -> GoogleOAuth:
    s = get_settings()
    if not s.google_configured:
        raise AppError("google.not_configured", 409)
    return GoogleOAuth(s, transport=google_transport)


def make_google(cancel: threading.Event | None = None) -> tuple[GoogleCalendarClient, GoogleOAuth]:
    oauth = make_oauth()
    provider = TokenProvider(oauth)
    client = GoogleCalendarClient(
        lambda force: provider.access_token(force), base_url=get_settings().google_api_base, transport=google_transport, cancel=cancel
    )
    return client, oauth


def set_credential_status(provider: str, status: str, error_code: str | None) -> None:
    with session_scope() as db:
        cred = db.get(Credential, provider)
        if cred is None:
            return
        cred.status = status
        cred.last_error_code = error_code
        cred.last_checked_at = utcnow()


# -- runs --------------------------------------------------------------------------------


def sync_running() -> bool:
    return is_locked(LOCK_NAME)


def _fail_run(run_id: int | None, opts: RunOptions, code: str, params: dict[str, object] | None = None) -> None:
    with session_scope() as db:
        run = db.get(SyncRun, run_id) if run_id else None
        if run is None:
            run = SyncRun(trigger=opts.trigger, dry_run=opts.dry_run)
            db.add(run)
        run.status = "failed"
        run.message_code = code
        run.message_params = dict(params or {})
        run.finished_at = utcnow()


def _run_id(run_id: int | None, engine: SyncEngine | None) -> int | None:
    if run_id is not None:
        return run_id
    if engine is not None and engine.run_row is not None:
        return engine.run_row.id
    return None


def execute_run(opts: RunOptions, run_id: int | None = None) -> int | None:
    """Runs one sync under the pair lock. Never raises; outcome is persisted on the run."""
    global current_run_id
    with pair_lock(LOCK_NAME) as acquired:
        if not acquired:
            if run_id is not None:
                _fail_run(run_id, opts, "sync.already_running")
            return run_id
        current_run_id = run_id
        caldav = google = oauth = None
        engine: SyncEngine | None = None
        try:
            with session_scope() as db:
                s = app_settings(db)
                if not s.source_calendar_url or not s.target_calendar_id:
                    if opts.trigger == "schedule":
                        return None
                    raise AppError("sync.not_configured", 409)
                apple_id, password = icloud_credentials(db)
                caldav = make_caldav(apple_id, password, cancel=shutdown_event)
                google, oauth = make_google(cancel=shutdown_event)
                run = db.get(SyncRun, run_id) if run_id else None
                engine = SyncEngine(db, caldav, google, cancel=shutdown_event)
                result = engine.run(opts, run)
                result_id = result.id if result else None
                if result is not None:
                    level = "info" if result.status == "success" else "warning"
                    log_event(
                        level,
                        "sync",
                        result.message_code,
                        {"run_id": result.id, "created": result.created, "updated": result.updated, "deleted": result.deleted, "failed": result.failed},
                        db=db,
                    )
            set_credential_status("icloud", "ok", None)
            set_credential_status("google", "ok", None)
            return result_id
        except ICloudAuthError as exc:
            set_credential_status("icloud", "error", exc.code)
            _fail_run(_run_id(run_id, engine), opts, exc.code)
            log_event("error", "icloud", exc.code, {})
        except GoogleReauthRequired as exc:
            set_credential_status("google", "reauth_required", exc.code)
            _fail_run(_run_id(run_id, engine), opts, exc.code)
            log_event("error", "google", exc.code, {})
        except AppError as exc:
            category = exc.code.split(".", 1)[0] if exc.code.split(".", 1)[0] in ("icloud", "google") else "sync"
            if category in ("icloud", "google") and exc.code not in ("icloud.not_configured", "google.not_connected", "google.not_configured"):
                set_credential_status(category, "error", exc.code)
            _fail_run(_run_id(run_id, engine), opts, exc.code, exc.params)
            log_event("error", category, exc.code, exc.params)
        except Exception:
            log.exception("sync run crashed")
            _fail_run(_run_id(run_id, engine), opts, "internal.error")
            log_event("error", "sync", "internal.error", {})
        finally:
            current_run_id = None
            for closable in (caldav, google, oauth):
                if closable is not None:
                    closable.close()
        return run_id


def start_manual_run(dry_run: bool, allow_mass_deletion: bool) -> int:
    if sync_running():
        raise AppError("sync.already_running", 409)
    opts = RunOptions(trigger="dry_run" if dry_run else "manual", dry_run=dry_run, allow_mass_deletion=allow_mass_deletion, force_full=True)
    with session_scope() as db:
        s = app_settings(db)
        if not s.source_calendar_url or not s.target_calendar_id:
            raise AppError("sync.not_configured", 409)
        run = SyncRun(trigger=opts.trigger, dry_run=dry_run, status="running")
        db.add(run)
        db.flush()
        run_id = run.id
    spawn(lambda: execute_run(opts, run_id), name=f"sync-run-{run_id}")
    return run_id


def spawn(target: object, name: str) -> threading.Thread:
    def runner() -> None:
        try:
            target()  # type: ignore[operator]
        finally:
            with _threads_guard:
                _threads.discard(thread)

    thread = threading.Thread(target=runner, name=name, daemon=False)
    with _threads_guard:
        _threads.add(thread)
    thread.start()
    return thread


def join_threads(timeout: float) -> None:
    with _threads_guard:
        threads = list(_threads)
    for t in threads:
        t.join(timeout)


def scheduled_run() -> None:
    if shutdown_event.is_set():
        return
    with session_scope() as db:
        if not app_settings(db).sync_enabled:
            return
    execute_run(RunOptions(trigger="schedule"))
    prune_history()


def prune_history() -> None:
    cutoff = datetime.now(UTC) - RETENTION
    with session_scope() as db:
        db.execute(delete(SyncRun).where(SyncRun.started_at < cutoff))
        db.execute(delete(LogEntry).where(LogEntry.ts < cutoff))


def recover_interrupted_runs() -> None:
    """Runs left in 'running' after a crash/restart are closed as failed."""
    with session_scope() as db:
        for run in db.query(SyncRun).filter(SyncRun.status == "running"):
            run.status = "failed"
            run.message_code = "sync.cancelled"
            run.finished_at = utcnow()
