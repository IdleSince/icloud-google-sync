"""Glue between API, scheduler and the sync engine."""

from __future__ import annotations

import logging
import threading
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .caldav.client import CalDAVClient
from .config import get_settings
from .crypto import decrypt
from .db import session_scope
from .errors import AppError, GoogleReauthRequired, ICloudAuthError
from .google.calendar import GoogleCalendarClient
from .google.oauth import GoogleOAuth, TokenProvider
from .logging_setup import log_event
from .models import AppSettings, Credential, LogEntry, SyncPair, SyncRun, utcnow
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


def _fail_run(run_id: int | None, opts: RunOptions, code: str, params: dict[str, object] | None = None, pair_id: int | None = None) -> int:
    with session_scope() as db:
        run = db.get(SyncRun, run_id) if run_id else None
        if run is None:
            run = SyncRun(trigger=opts.trigger, dry_run=opts.dry_run)
            pair = db.get(SyncPair, pair_id) if pair_id else None
            if pair is not None:
                run.pair_id, run.calendar_name = pair.id, pair.source_calendar_name
                run.source_calendar_url, run.target_calendar_id = pair.source_calendar_url, pair.target_calendar_id
            db.add(run)
        run.status = "failed"
        run.message_code = code
        run.message_params = dict(params or {})
        run.finished_at = utcnow()
        db.flush()
        return run.id


def _run_id(run_id: int | None, engine: SyncEngine | None) -> int | None:
    if run_id is not None:
        return run_id
    if engine is not None and engine.run_row is not None:
        return engine.run_row.id
    return None


def runnable_pairs(db: Session, pair_ids: list[int] | None = None) -> list[SyncPair]:
    """Pairs with a target, oldest first: all enabled ones, or exactly the given ids."""
    query = select(SyncPair).where(SyncPair.target_calendar_id.is_not(None)).order_by(SyncPair.id)
    if pair_ids is not None:
        query = query.where(SyncPair.id.in_(pair_ids))
    else:
        query = query.where(SyncPair.enabled.is_(True))
    return list(db.execute(query).scalars())


# Errors that concern the whole account/connection: the remaining pairs would fail the same way.
FATAL_CODES = {"icloud.unreachable", "icloud.not_configured", "google.not_connected", "google.not_configured"}
ACCOUNT_CODES = {"icloud.unreachable", "icloud.unexpected_response", "google.api_error", "google.rate_limited"}


def _handle_error(exc: Exception, run_id: int | None, opts: RunOptions, pair_id: int | None) -> tuple[str, bool, int]:
    """Persists the failure on the run. Returns (code, fatal, run id); fatal stops the remaining pairs."""
    if isinstance(exc, ICloudAuthError):
        set_credential_status("icloud", "error", exc.code)
        failed = _fail_run(run_id, opts, exc.code, pair_id=pair_id)
        log_event("error", "icloud", exc.code, {})
        return exc.code, True, failed
    if isinstance(exc, GoogleReauthRequired):
        set_credential_status("google", "reauth_required", exc.code)
        failed = _fail_run(run_id, opts, exc.code, pair_id=pair_id)
        log_event("error", "google", exc.code, {})
        return exc.code, True, failed
    if isinstance(exc, AppError):
        prefix = exc.code.split(".", 1)[0]
        category = prefix if prefix in ("icloud", "google") else "sync"
        # A missing or locked calendar is a problem of that pair, not of the whole account.
        if category in ("icloud", "google") and exc.code in ACCOUNT_CODES:
            set_credential_status(category, "error", exc.code)
        failed = _fail_run(run_id, opts, exc.code, exc.params, pair_id=pair_id)
        log_event("error", category, exc.code, {**exc.params, **({"pair_id": pair_id} if pair_id else {})})
        return exc.code, exc.code in FATAL_CODES, failed
    log.exception("sync run crashed")
    failed = _fail_run(run_id, opts, "internal.error", pair_id=pair_id)
    log_event("error", "sync", "internal.error", {})
    return "internal.error", False, failed


def execute_run(opts: RunOptions, run_ids: dict[int, int] | None = None, pair_ids: list[int] | None = None) -> list[int]:
    """Syncs the runnable pairs one after another under the global lock.

    Never raises; every outcome is persisted on a run row. `run_ids` maps pair id -> pre-created
    run (manual runs, those pairs are synced). Returns the ids of the runs written; a pair skipped
    as unchanged has none.
    """
    global current_run_id
    run_ids = dict(run_ids or {})
    if pair_ids is None and run_ids:
        pair_ids = list(run_ids)
    with pair_lock(LOCK_NAME) as acquired:
        if not acquired:
            for rid in run_ids.values():
                _fail_run(rid, opts, "sync.already_running")
            return list(run_ids.values())
        written: list[int] = []
        caldav = google = oauth = None
        try:
            try:
                with session_scope() as db:
                    targets = [p.id for p in runnable_pairs(db, pair_ids)]
                    if not targets:
                        if opts.trigger == "schedule":
                            return []
                        raise AppError("sync.not_configured", 409)
                    apple_id, password = icloud_credentials(db)
                caldav = make_caldav(apple_id, password, cancel=shutdown_event)
                google, oauth = make_google(cancel=shutdown_event)
            except Exception as exc:
                for pid, rid in list(run_ids.items()) or [(0, 0)]:
                    _handle_error(exc, rid or None, opts, pid or None)
                return list(run_ids.values())

            any_ok = False
            for index, pair_id in enumerate(targets):
                remaining = targets[index + 1 :]
                if shutdown_event.is_set():
                    for pid in targets[index:]:
                        if pid in run_ids:
                            _fail_run(run_ids[pid], opts, "sync.cancelled")
                    break
                run_id = run_ids.get(pair_id)
                current_run_id = run_id
                engine: SyncEngine | None = None
                try:
                    with session_scope() as db:
                        pair = db.get(SyncPair, pair_id)
                        if pair is None:
                            raise AppError("sync.not_configured", 409)
                        run = db.get(SyncRun, run_id) if run_id else None
                        engine = SyncEngine(db, caldav, google, cancel=shutdown_event)
                        result = engine.run(opts, pair, run)
                        if result is not None:
                            written.append(result.id)
                            log_event(
                                "info" if result.status == "success" else "warning",
                                "sync",
                                result.message_code,
                                {
                                    "run_id": result.id,
                                    "pair_id": pair_id,
                                    "created": result.created,
                                    "updated": result.updated,
                                    "deleted": result.deleted,
                                    "failed": result.failed,
                                },
                                db=db,
                            )
                    any_ok = True
                except Exception as exc:
                    code, fatal, failed_id = _handle_error(exc, _run_id(run_id, engine), opts, pair_id)
                    written.append(failed_id)
                    if fatal:
                        for pid in remaining:
                            if pid in run_ids:
                                _fail_run(run_ids[pid], opts, code)
                                written.append(run_ids[pid])
                        break
            if any_ok:
                set_credential_status("icloud", "ok", None)
                set_credential_status("google", "ok", None)
            return written
        finally:
            current_run_id = None
            for closable in (caldav, google, oauth):
                if closable is not None:
                    closable.close()


def start_manual_run(dry_run: bool, allow_mass_deletion: bool, pair_id: int | None = None) -> list[int]:
    """Creates one run row per pair up front (so the UI can follow them) and starts the work."""
    if sync_running():
        raise AppError("sync.already_running", 409)
    opts = RunOptions(trigger="dry_run" if dry_run else "manual", dry_run=dry_run, allow_mass_deletion=allow_mass_deletion, force_full=True)
    with session_scope() as db:
        pairs = runnable_pairs(db, [pair_id] if pair_id is not None else None)
        if not pairs:
            raise AppError("sync.not_configured", 409)
        run_ids: dict[int, int] = {}
        for pair in pairs:
            run = SyncRun(
                trigger=opts.trigger,
                dry_run=dry_run,
                status="running",
                pair_id=pair.id,
                calendar_name=pair.source_calendar_name,
                source_calendar_url=pair.source_calendar_url,
                target_calendar_id=pair.target_calendar_id,
            )
            db.add(run)
            db.flush()
            run_ids[pair.id] = run.id
    spawn(lambda: execute_run(opts, run_ids), name=f"sync-run-{min(run_ids.values())}")
    return list(run_ids.values())


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
