"""Calendar pairs: one iCloud calendar -> one Google calendar each."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.orm import Session

from .. import services
from ..caldav.discovery import DiscoveredCalendar, calendar_id, discover
from ..config import get_settings
from ..db import get_db
from ..errors import AppError, ICloudError
from ..google.oauth import SCOPE_EVENTS_OWNED, granted_scopes
from ..logging_setup import log_event
from ..models import AppSettings, Credential, EventMapping, SyncPair, SyncRun
from ..security import require_admin
from .common import iso, run_summary
from .google import _calendar_view, _created_ids

router = APIRouter(prefix="/api/pairs", tags=["pairs"], dependencies=[Depends(require_admin)])


class CreatePairBody(BaseModel):
    calendar_url: str = Field(min_length=8, max_length=1024)
    create_target: bool = True


class UpdatePairBody(BaseModel):
    enabled: bool | None = None


class TargetBody(BaseModel):
    calendar_id: str = Field(min_length=1, max_length=1024)
    confirm_primary: bool = False


class CreateTargetBody(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)


def suggested_target_name(pair: SyncPair) -> str:
    """E.g. "Arbeit (anna@example.com)" so several shared calendars stay distinguishable in Google."""
    name = (pair.source_calendar_name or "iCloud").strip()
    owner = (pair.source_calendar_owner or "").strip()
    return (f"{name} ({owner})" if owner else name)[:255]


def pair_dict(pair: SyncPair, mapped: int = 0, last_run: SyncRun | None = None) -> dict[str, Any]:
    return {
        "id": pair.id,
        "enabled": pair.enabled,
        "source": {
            "url": pair.source_calendar_url,
            "id": calendar_id(pair.source_calendar_url),
            "name": pair.source_calendar_name,
            "owner": pair.source_calendar_owner,
            "shared": pair.source_calendar_shared,
        },
        "target": (
            {"id": pair.target_calendar_id, "name": pair.target_calendar_name, "is_primary": pair.target_is_primary} if pair.target_calendar_id else None
        ),
        "suggested_target_name": suggested_target_name(pair),
        "last_success_at": iso(pair.last_success_at),
        "mapped_events": mapped,
        "last_run": run_summary(last_run) if last_run else None,
    }


def all_pairs(db: Session) -> list[dict[str, Any]]:
    """Every pair with its event count and last run - three queries regardless of the pair count."""
    pairs = list(db.execute(select(SyncPair).order_by(SyncPair.id)).scalars())
    counts = {
        (src, tgt): n
        for src, tgt, n in db.execute(
            select(EventMapping.source_calendar_url, EventMapping.target_calendar_id, func.count(EventMapping.id))
            .where(EventMapping.kind != "override")
            .group_by(EventMapping.source_calendar_url, EventMapping.target_calendar_id)
        ).all()
    }
    latest = select(func.max(SyncRun.id)).where(SyncRun.pair_id.is_not(None)).group_by(SyncRun.pair_id)
    runs = {r.pair_id: r for r in db.execute(select(SyncRun).where(SyncRun.id.in_(latest))).scalars()}
    return [pair_dict(p, counts.get((p.source_calendar_url, p.target_calendar_id or ""), 0), runs.get(p.id)) for p in pairs]


def _pair(db: Session, pair_id: int) -> SyncPair:
    pair = db.get(SyncPair, pair_id)
    if pair is None:
        raise AppError("pair.not_found", 404)
    return pair


def _verified_source(db: Session, calendar_url: str) -> DiscoveredCalendar:
    """The calendar must be one this Apple ID lists, hold events and be readable."""
    apple_id, password = services.icloud_credentials(db)
    with services.make_caldav(apple_id, password) as client:
        result = discover(client, count=False)
        match = next((c for c in result.calendars if c.id == calendar_id(calendar_url)), None)
        if match is None:
            raise AppError("icloud.calendar_not_found", 404)
        if not match.supports_events:
            raise AppError("icloud.calendar_no_events", 409)
        if match.error and match.error.get("code") == "icloud.calendar_not_readable":
            raise AppError("icloud.calendar_not_readable", 409)
        try:
            client.count_events(match.url)  # proves readability
        except ICloudError as exc:
            raise AppError("icloud.calendar_not_readable", 409) from exc
    return match


def _google_connected(db: Session) -> bool:
    cred = db.get(Credential, "google")
    return cred is not None and bool(cred.secret_enc)


def _set_target(db: Session, s: AppSettings, pair: SyncPair, entry: dict[str, Any], confirm_primary: bool) -> None:
    cal_id = str(entry["id"])
    if entry.get("primary") and (not s.allow_primary_target or not confirm_primary):
        raise AppError("google.primary_locked", 409)
    if entry.get("accessRole") not in ("owner", "writer"):
        raise AppError("google.calendar_not_writable", 409)
    other = db.execute(select(SyncPair.id).where(SyncPair.target_calendar_id == cal_id, SyncPair.id != pair.id)).first()
    if other is not None:
        # One Google calendar per iCloud calendar keeps deletions and the guard per pair unambiguous.
        raise AppError("google.target_in_use", 409)
    if pair.target_calendar_id != cal_id:
        pair.last_source_ctag = None
    pair.target_calendar_id = cal_id
    pair.target_calendar_name = str(entry.get("summaryOverride") or entry.get("summary") or cal_id)[:255]
    pair.target_is_primary = bool(entry.get("primary"))


def _create_target(db: Session, s: AppSettings, pair: SyncPair, name: str | None) -> None:
    client, oauth = services.make_google()
    try:
        created = client.create_calendar((name or suggested_target_name(pair)).strip(), s.default_timezone)
        entry = client.get_calendar_entry(created["id"]) or {**created, "accessRole": "owner"}
    finally:
        client.close()
        oauth.close()
    s.created_calendar_ids = [*_created_ids(s), str(created["id"])]
    _set_target(db, s, pair, entry, confirm_primary=False)
    log_event("info", "google", "google.calendar_created", {"pair_id": pair.id}, db=db)


@router.get("")
def list_pairs(db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"pairs": all_pairs(db)}


@router.post("", status_code=201)
def create_pair(body: CreatePairBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    match = _verified_source(db, body.calendar_url)
    existing = db.execute(select(SyncPair).where(SyncPair.source_calendar_url == match.url)).scalar_one_or_none()
    if existing is not None:
        raise AppError("pair.exists", 409)
    pair = SyncPair(
        enabled=True,
        source_calendar_url=match.url,
        source_calendar_name=match.name[:255],
        source_calendar_owner=(match.owner or None) and match.owner[:255],
        source_calendar_shared=match.ownership == "shared",
        target_is_primary=False,
    )
    db.add(pair)
    db.flush()
    log_event("info", "icloud", "icloud.source_selected", {"pair_id": pair.id, "calendar_id": match.id, "shared": pair.source_calendar_shared}, db=db)
    if body.create_target and _google_connected(db) and get_settings().google_configured:
        _create_target(db, services.app_settings(db), pair, None)
    db.flush()
    return {"pair": pair_dict(pair)}


@router.patch("/{pair_id}")
def update_pair(pair_id: int, body: UpdatePairBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    pair = _pair(db, pair_id)
    if body.enabled is not None:
        pair.enabled = body.enabled
        log_event("info", "sync", "pair.enabled" if body.enabled else "pair.disabled", {"pair_id": pair.id}, db=db)
    db.flush()
    return {"pair": pair_dict(pair)}


@router.delete("/{pair_id}", status_code=204)
def delete_pair(pair_id: int, db: Session = Depends(get_db)) -> Response:
    """Stops syncing this calendar. Nothing is deleted in Google or iCloud; run history stays."""
    if services.sync_running():
        raise AppError("sync.already_running", 409)
    pair = _pair(db, pair_id)
    db.execute(delete(EventMapping).where(EventMapping.source_calendar_url == pair.source_calendar_url))
    db.execute(update(SyncRun).where(SyncRun.pair_id == pair.id).values(pair_id=None))
    db.delete(pair)
    log_event("info", "sync", "pair.removed", {"pair_id": pair_id}, db=db)
    return Response(status_code=204)


@router.put("/{pair_id}/target")
def set_target(pair_id: int, body: TargetBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    pair = _pair(db, pair_id)
    s = services.app_settings(db)
    extended = SCOPE_EVENTS_OWNED in granted_scopes(db.get(Credential, "google"))
    client, oauth = services.make_google()
    try:
        entry = client.get_calendar_entry(body.calendar_id)
    finally:
        client.close()
        oauth.close()
    if entry is None:
        raise AppError("google.calendar_not_found", 404)
    if _calendar_view(entry, s, extended, {})["lock_reason"] == "scope_missing":
        raise AppError("google.scope_missing", 403)
    _set_target(db, s, pair, entry, body.confirm_primary)
    log_event("info", "google", "google.target_selected", {"pair_id": pair.id, "primary": bool(entry.get("primary"))}, db=db)
    db.flush()
    return {"pair": pair_dict(pair)}


@router.post("/{pair_id}/target")
def create_target(pair_id: int, body: CreateTargetBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    pair = _pair(db, pair_id)
    _create_target(db, services.app_settings(db), pair, body.name)
    db.flush()
    return {"pair": pair_dict(pair)}
