from __future__ import annotations

import platform
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import scheduler, services
from ..config import APP_VERSION, get_settings
from ..db import current_migration, get_db
from ..models import EventMapping, LogEntry, SyncRun
from ..security import require_admin
from .common import iso, log_entry, run_summary
from .google import google_status, target_dict
from .icloud import icloud_status, source_dict

public = APIRouter(tags=["health"])
router = APIRouter(prefix="/api", tags=["status"], dependencies=[Depends(require_admin)])


@public.get("/api/health")
def health(db: Session = Depends(get_db)) -> dict[str, str]:
    db.execute(select(1))
    return {"status": "ok"}


@router.get("/status")
def status(db: Session = Depends(get_db)) -> dict[str, Any]:
    s = services.app_settings(db)
    mapped = 0
    if s.source_calendar_url and s.target_calendar_id:
        mapped = db.execute(
            select(func.count(EventMapping.id)).where(
                EventMapping.source_calendar_url == s.source_calendar_url,
                EventMapping.target_calendar_id == s.target_calendar_id,
                EventMapping.kind != "override",
            )
        ).scalar_one()
    last_run = db.execute(select(SyncRun).order_by(SyncRun.id.desc()).limit(1)).scalar_one_or_none()
    errors = db.execute(select(LogEntry).where(LogEntry.level == "error").order_by(LogEntry.id.desc()).limit(5)).scalars().all()
    return {
        "icloud": icloud_status(db),
        "google": google_status(db),
        "source": source_dict(s),
        "target": target_dict(s),
        "sync": {
            "enabled": s.sync_enabled,
            "interval_minutes": s.interval_minutes,
            "running": services.sync_running(),
            "current_run_id": services.current_run_id,
            "last_success_at": iso(s.last_success_at),
            "next_run_at": iso(scheduler.next_run_at()) if s.sync_enabled else None,
        },
        "mapped_events": mapped,
        "last_run": run_summary(last_run) if last_run else None,
        "recent_errors": [log_entry(e) for e in errors],
    }


@router.get("/logs")
def logs(
    db: Session = Depends(get_db),
    level: str | None = Query(default=None, pattern="^(info|warning|error)$"),
    category: str | None = Query(default=None, pattern="^(sync|icloud|google|auth|system)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    query = select(LogEntry)
    count = select(func.count(LogEntry.id))
    if level:
        query, count = query.where(LogEntry.level == level), count.where(LogEntry.level == level)
    if category:
        query, count = query.where(LogEntry.category == category), count.where(LogEntry.category == category)
    rows = db.execute(query.order_by(LogEntry.id.desc()).limit(limit).offset(offset)).scalars().all()
    return {"items": [log_entry(r) for r in rows], "total": db.execute(count).scalar_one()}


@router.get("/stats")
def stats(db: Session = Depends(get_db), days: int = Query(default=30, ge=1, le=90)) -> dict[str, Any]:
    today = datetime.now(UTC).date()
    start = datetime.combine(today - timedelta(days=days - 1), datetime.min.time(), tzinfo=UTC)
    runs = db.execute(select(SyncRun).where(SyncRun.started_at >= start)).scalars().all()
    buckets: dict[str, dict[str, Any]] = {}
    for i in range(days):
        day = (today - timedelta(days=days - 1 - i)).isoformat()
        buckets[day] = {"date": day, "runs": 0, "failed_runs": 0, "created": 0, "updated": 0, "deleted": 0}
    for run in runs:
        b = buckets.get(run.started_at.date().isoformat())
        if b is None:
            continue
        b["runs"] += 1
        b["failed_runs"] += 1 if run.status == "failed" else 0
        if not run.dry_run:
            b["created"] += run.created
            b["updated"] += run.updated
            b["deleted"] += run.deleted
    return {"days": list(buckets.values())}


@router.get("/diagnostics")
def diagnostics() -> dict[str, Any]:
    settings = get_settings()
    try:
        migration = current_migration()
        db_ok = True
    except Exception:
        migration, db_ok = None, False
    sched = scheduler.info()
    return {
        "app_version": APP_VERSION,
        "python_version": platform.python_version(),
        "base_url": settings.app_base_url,
        "redirect_uri": settings.google_redirect_uri,
        "database": {"ok": db_ok, "migration": migration},
        "scheduler": {"running": sched["running"], "next_run_at": iso(sched["next_run_at"]), "job_count": sched["job_count"]},  # type: ignore[arg-type]
        "secrets": {
            "encryption_key": bool(settings.app_encryption_key),
            "google_client": settings.google_configured,
            "admin_password": bool(settings.admin_password),
        },
        "secure_cookies": settings.secure_cookies,
        "server_time": iso(datetime.now(UTC)),
    }
