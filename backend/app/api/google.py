from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .. import services
from ..config import get_settings
from ..crypto import decrypt, encrypt, random_token, sha256_hex
from ..db import get_db
from ..errors import AppError, GoogleError
from ..google.oauth import SCOPE_EVENTS_OWNED, authorization_url, granted_scopes, pkce_pair, store_tokens
from ..logging_setup import log_event
from ..models import AppSettings, Credential, OAuthState, utcnow
from ..security import current_session, require_admin
from .common import iso

router = APIRouter(prefix="/api/google", tags=["google"])
admin = [Depends(require_admin)]

STATE_TTL = timedelta(minutes=10)


class StartBody(BaseModel):
    extended: bool = False


class CreateCalendarBody(BaseModel):
    name: str = Field(default="iCloud Sync", min_length=1, max_length=255)
    select: bool = True


class TargetBody(BaseModel):
    calendar_id: str = Field(min_length=1, max_length=1024)
    confirm_primary: bool = False


def _created_ids(s: AppSettings) -> list[str]:
    return list(s.created_calendar_ids or [])


def google_status(db: Session) -> dict[str, Any]:
    cred = db.get(Credential, "google")
    connected = cred is not None and bool(cred.secret_enc)
    return {
        "configured_on_server": get_settings().google_configured,
        "connected": connected,
        "status": (cred.status if cred and cred.status in ("ok", "error", "reauth_required") else "unknown") if connected else "unknown",
        "account": decrypt(cred.account_enc, "google.account") if connected and cred and cred.account_enc else None,
        "extended_access": SCOPE_EVENTS_OWNED in granted_scopes(cred),
        "last_checked_at": iso(cred.last_checked_at) if cred else None,
        "error": {"code": cred.last_error_code, "params": {}} if cred and cred.last_error_code else None,
    }


@router.post("/oauth/start", dependencies=admin)
def oauth_start(body: StartBody, request: Request, db: Session = Depends(get_db)) -> dict[str, str]:
    settings = get_settings()
    if not settings.google_configured:
        raise AppError("google.not_configured", 409)
    session = current_session(request, db)
    assert session is not None  # guaranteed by require_admin
    state = random_token(32)
    verifier, challenge = pkce_pair()
    now = datetime.now(UTC)
    db.execute(delete(OAuthState).where(OAuthState.expires_at < now))
    db.add(
        OAuthState(
            state_hash=sha256_hex(state),
            session_hash=session.token_hash,
            code_verifier_enc=encrypt(verifier, "google.pkce"),
            extended=body.extended,
            created_at=now,
            expires_at=now + STATE_TTL,
        )
    )
    return {"authorization_url": authorization_url(settings, state, challenge, body.extended)}


def _back(params: dict[str, str]) -> RedirectResponse:
    return RedirectResponse(f"{get_settings().app_base_url}/google?{urlencode(params)}", status_code=302)


@router.get("/oauth/callback", include_in_schema=False)
def oauth_callback(request: Request, db: Session = Depends(get_db), state: str = "", code: str = "", error: str = "") -> RedirectResponse:
    session = current_session(request, db)
    record = db.get(OAuthState, sha256_hex(state)) if state else None
    # Single use: delete before anything else can fail.
    if record is not None:
        db.delete(record)
        db.commit()
    if record is None or session is None or record.session_hash != session.token_hash or record.expires_at <= datetime.now(UTC):
        log_event("warning", "google", "google.oauth_state_invalid", {}, db=db)
        return _back({"error": "google.oauth_state_invalid"})
    if error:
        log_event("warning", "google", "google.oauth_denied", {}, db=db)
        return _back({"error": "google.oauth_denied"})
    if not code:
        return _back({"error": "google.oauth_failed"})
    try:
        oauth = services.make_oauth()
        try:
            tokens = oauth.exchange_code(code, decrypt(record.code_verifier_enc, "google.pkce"))
        finally:
            oauth.close()
        old = db.get(Credential, "google")
        if old is not None:
            db.delete(old)
            db.flush()
        store_tokens(db, tokens, None)
        db.commit()
        client, oauth2 = services.make_google()
        try:
            account = client.account_email()
        finally:
            client.close()
            oauth2.close()
        stored = db.get(Credential, "google")
        if stored is not None and account:
            stored.account_enc = encrypt(account, "google.account")
    except AppError as exc:
        log_event("error", "google", exc.code, exc.params, db=db)
        return _back({"error": exc.code})
    log_event("info", "google", "google.connected", {"extended": record.extended}, db=db)
    return _back({"connected": "1"})


@router.post("/test", dependencies=admin)
def test(db: Session = Depends(get_db)) -> dict[str, Any]:
    client, oauth = services.make_google()
    try:
        account = client.account_email()
        error = None
    except GoogleError as exc:
        account, error = None, exc.to_dict()
    except AppError as exc:
        if exc.code == "google.not_connected":
            raise
        account, error = None, exc.to_dict()
    finally:
        client.close()
        oauth.close()
    cred = db.get(Credential, "google")
    if cred is not None:
        if error is None:
            cred.status, cred.last_error_code = "ok", None
        elif error["code"] != "google.reauth_required":
            cred.status, cred.last_error_code = "error", error["code"]
        cred.last_checked_at = utcnow()
    return {"ok": error is None, "error": error, "account": account}


def _calendar_view(entry: dict[str, Any], s: AppSettings, extended: bool) -> dict[str, Any]:
    cal_id = str(entry.get("id"))
    created = cal_id in _created_ids(s)
    role = entry.get("accessRole", "reader")
    lock: str | None = None
    if role not in ("owner", "writer"):
        lock = "not_writable"
    elif entry.get("primary") and not s.allow_primary_target:
        lock = "primary_locked"
    elif not created and (not extended or role != "owner"):
        lock = "scope_missing" if role == "owner" else "not_writable"
    return {
        "id": cal_id,
        "name": entry.get("summaryOverride") or entry.get("summary") or cal_id,
        "primary": bool(entry.get("primary")),
        "access_role": role,
        "created_by_app": created,
        "selectable": lock is None,
        "lock_reason": lock,
        "selected": cal_id == s.target_calendar_id,
        "color": entry.get("backgroundColor"),
    }


@router.get("/calendars", dependencies=admin)
def calendars(db: Session = Depends(get_db)) -> dict[str, Any]:
    s = services.app_settings(db)
    extended = SCOPE_EVENTS_OWNED in granted_scopes(db.get(Credential, "google"))
    client, oauth = services.make_google()
    try:
        entries = client.list_calendars()
    finally:
        client.close()
        oauth.close()
    views = [_calendar_view(e, s, extended) for e in entries]
    views.sort(key=lambda c: (not c["selected"], not c["created_by_app"], c["primary"], str(c["name"]).casefold()))
    return {"calendars": views}


@router.post("/calendars", dependencies=admin)
def create_calendar(body: CreateCalendarBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    s = services.app_settings(db)
    client, oauth = services.make_google()
    try:
        created = client.create_calendar(body.name.strip(), s.default_timezone)
        entry = client.get_calendar_entry(created["id"]) or {**created, "accessRole": "owner"}
    finally:
        client.close()
        oauth.close()
    s.created_calendar_ids = [*_created_ids(s), created["id"]]
    if body.select:
        _select(s, entry, confirm_primary=False)
    db.flush()
    log_event("info", "google", "google.calendar_created", {}, db=db)
    return {"calendar": _calendar_view(entry, s, False)}


def _select(s: AppSettings, entry: dict[str, Any], confirm_primary: bool) -> None:
    if entry.get("primary"):
        if not s.allow_primary_target or not confirm_primary:
            raise AppError("google.primary_locked", 409)
    if entry.get("accessRole") not in ("owner", "writer"):
        raise AppError("google.calendar_not_writable", 409)
    if s.target_calendar_id != entry["id"]:
        s.last_source_ctag = None
    s.target_calendar_id = str(entry["id"])
    s.target_calendar_name = str(entry.get("summaryOverride") or entry.get("summary") or entry["id"])[:255]
    s.target_is_primary = bool(entry.get("primary"))


@router.put("/target", dependencies=admin)
def set_target(body: TargetBody, db: Session = Depends(get_db)) -> dict[str, Any]:
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
    view = _calendar_view(entry, s, extended)
    if view["lock_reason"] == "scope_missing":
        raise AppError("google.scope_missing", 403)
    _select(s, entry, body.confirm_primary)
    log_event("info", "google", "google.target_selected", {"primary": bool(entry.get("primary"))}, db=db)
    return {"target": target_dict(s)}


def target_dict(s: AppSettings) -> dict[str, Any] | None:
    if not s.target_calendar_id:
        return None
    return {"id": s.target_calendar_id, "name": s.target_calendar_name, "is_primary": s.target_is_primary}


@router.delete("/connection", status_code=204, dependencies=admin)
def disconnect(db: Session = Depends(get_db)) -> Response:
    cred = db.get(Credential, "google")
    if cred is not None:
        if cred.secret_enc and get_settings().google_configured:
            oauth = services.make_oauth()
            try:
                oauth.revoke(decrypt(cred.secret_enc, "google.refresh_token"))
            finally:
                oauth.close()
        db.delete(cred)
    s = services.app_settings(db)
    s.target_calendar_id = s.target_calendar_name = None
    s.target_is_primary = False
    s.last_source_ctag = None
    log_event("info", "google", "google.disconnected", {}, db=db)
    return Response(status_code=204)
