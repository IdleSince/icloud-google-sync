from __future__ import annotations

from typing import Any
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session, selectinload

from .. import scheduler, services
from ..db import get_db
from ..errors import AppError
from ..logging_setup import log_event
from ..models import AppSettings, SyncPair, SyncRun
from ..security import require_admin
from .common import iso, run_detail, run_summary

router = APIRouter(prefix="/api/sync", tags=["sync"], dependencies=[Depends(require_admin)])


class SettingsBody(BaseModel):
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=1, le=1440)
    past_months: int | None = Field(default=None, ge=0, le=120)
    future_months: int | None = Field(default=None, ge=1, le=120)
    deletion_dry_run: bool | None = None
    deletion_max_absolute: int | None = Field(default=None, ge=0, le=100000)
    deletion_max_percent: int | None = Field(default=None, ge=0, le=100)
    sync_reminders: bool | None = None
    sync_descriptions: bool | None = None
    default_timezone: str | None = Field(default=None, max_length=64)
    allow_primary_target: bool | None = None


class RunBody(BaseModel):
    dry_run: bool = False
    allow_mass_deletion: bool = False
    pair_id: int | None = Field(default=None, ge=1)


def settings_dict(s: AppSettings) -> dict[str, Any]:
    return {
        "enabled": s.sync_enabled,
        "interval_minutes": s.interval_minutes,
        "past_months": s.past_months,
        "future_months": s.future_months,
        "deletion_dry_run": s.deletion_dry_run,
        "deletion_max_absolute": s.deletion_max_absolute,
        "deletion_max_percent": s.deletion_max_percent,
        "sync_reminders": s.sync_reminders,
        "sync_descriptions": s.sync_descriptions,
        "default_timezone": s.default_timezone,
        "allow_primary_target": s.allow_primary_target,
    }


@router.get("/settings")
def get_settings_(db: Session = Depends(get_db)) -> dict[str, Any]:
    return settings_dict(services.app_settings(db))


@router.put("/settings")
def put_settings(body: SettingsBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = services.app_settings(db)
    data = body.model_dump(exclude_none=True)
    if "default_timezone" in data and data["default_timezone"] not in available_timezones():
        raise AppError("validation.invalid", 422, {"fields": ["default_timezone"]})
    if data.get("allow_primary_target") is False:
        # Locking the primary calendar again also unselects it wherever it is a target.
        db.execute(
            update(SyncPair).where(SyncPair.target_is_primary.is_(True)).values(target_calendar_id=None, target_calendar_name=None, target_is_primary=False)
        )
    mapping = {"enabled": "sync_enabled"}
    for key, value in data.items():
        setattr(s, mapping.get(key, key), value)
    db.flush()
    if "interval_minutes" in data:
        scheduler.reschedule(s.interval_minutes)
    log_event("info", "system", "settings.updated", {"fields": sorted(data)}, db=db)
    return settings_dict(s)


@router.post("/runs", status_code=202)
def start_run(body: RunBody) -> JSONResponse:
    run_ids = services.start_manual_run(body.dry_run, body.allow_mass_deletion, body.pair_id)
    return JSONResponse({"run_id": run_ids[0], "run_ids": run_ids}, status_code=202)


@router.get("/runs")
def list_runs(
    db: Session = Depends(get_db),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    status: str | None = Query(default=None, pattern="^(running|success|partial|failed|skipped)$"),
) -> dict[str, Any]:
    query = select(SyncRun)
    count = select(func.count(SyncRun.id))
    if status:
        query = query.where(SyncRun.status == status)
        count = count.where(SyncRun.status == status)
    runs = db.execute(query.order_by(SyncRun.id.desc()).limit(limit).offset(offset)).scalars().all()
    return {"items": [run_summary(r) for r in runs], "total": db.execute(count).scalar_one()}


@router.get("/runs/{run_id}")
def get_run(run_id: int, db: Session = Depends(get_db)) -> dict[str, Any]:
    run = db.execute(select(SyncRun).options(selectinload(SyncRun.items)).where(SyncRun.id == run_id)).scalar_one_or_none()
    if run is None:
        raise AppError("validation.invalid", 404, {"fields": ["run_id"]})
    return run_detail(run)


@router.get("/state")
def state() -> dict[str, Any]:
    return {"running": services.sync_running(), "current_run_id": services.current_run_id, "next_run_at": iso(scheduler.next_run_at())}
