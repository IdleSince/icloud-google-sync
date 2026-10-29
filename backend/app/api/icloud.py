from __future__ import annotations

import re
from typing import Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import services
from ..caldav.discovery import calendar_id, diagnose, discover
from ..crypto import decrypt, encrypt
from ..db import get_db
from ..errors import AppError, ICloudAuthError, ICloudError
from ..logging_setup import log_event
from ..models import Credential, SyncPair, utcnow
from ..security import require_admin
from .common import iso, mask_email

router = APIRouter(prefix="/api/icloud", tags=["icloud"], dependencies=[Depends(require_admin)])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
APP_PASSWORD_RE = re.compile(r"^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$")


class CredentialsBody(BaseModel):
    apple_id: str = Field(min_length=3, max_length=320)
    app_password: str = Field(min_length=1, max_length=64)


def icloud_status(db: Session) -> dict[str, Any]:
    cred = db.get(Credential, "icloud")
    if cred is None or not cred.secret_enc:
        return {"configured": False, "status": "unknown", "account_masked": None, "last_checked_at": None, "error": None}
    account = decrypt(cred.account_enc, "icloud.account") if cred.account_enc else None
    return {
        "configured": True,
        "status": cred.status if cred.status in ("ok", "error") else "unknown",
        "account_masked": mask_email(account),
        "last_checked_at": iso(cred.last_checked_at),
        "error": {"code": cred.last_error_code, "params": {}} if cred.last_error_code else None,
    }


@router.put("/credentials")
def put_credentials(body: CredentialsBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    apple_id = body.apple_id.strip()
    password = body.app_password.strip().lower()
    if not EMAIL_RE.match(apple_id):
        raise AppError("icloud.invalid_apple_id", 422)
    if not APP_PASSWORD_RE.match(password):
        # Apple app-specific passwords always look like xxxx-xxxx-xxxx-xxxx. Rejecting anything else
        # makes sure the regular Apple ID password is never stored here.
        raise AppError("icloud.invalid_app_password_format", 422)
    with services.make_caldav(apple_id, password) as client:
        principal = client.current_user_principal()  # raises icloud.auth_failed on 401
        client.calendar_home(principal)
    cred = db.get(Credential, "icloud") or Credential(provider="icloud")
    cred.account_enc = encrypt(apple_id, "icloud.account")
    cred.secret_enc = encrypt(password, "icloud.app_password")
    cred.status, cred.last_error_code, cred.last_checked_at = "ok", None, utcnow()
    db.add(cred)
    db.flush()
    log_event("info", "icloud", "icloud.credentials_saved", {}, db=db)
    return icloud_status(db)


@router.delete("/credentials", status_code=204)
def delete_credentials(db: Session = Depends(get_db)) -> Response:
    cred = db.get(Credential, "icloud")
    if cred is not None:
        db.delete(cred)
    # Pairs stay (a new app password for the same Apple ID keeps working); force a full fetch.
    db.execute(update(SyncPair).values(last_source_ctag=None))
    log_event("info", "icloud", "icloud.credentials_removed", {}, db=db)
    return Response(status_code=204)


@router.post("/test")
def test_connection(db: Session = Depends(get_db)) -> dict[str, Any]:
    apple_id, password = services.icloud_credentials(db)
    principal_found = home_found = False
    error: dict[str, Any] | None = None
    try:
        with services.make_caldav(apple_id, password) as client:
            principal = client.current_user_principal()
            principal_found = True
            client.calendar_home(principal)
            home_found = True
    except ICloudError as exc:
        error = exc.to_dict()
    cred = db.get(Credential, "icloud")
    if cred is not None:
        cred.status = "ok" if error is None else "error"
        cred.last_error_code = error["code"] if error else None
        cred.last_checked_at = utcnow()
    return {"ok": error is None, "error": error, "principal_found": principal_found, "calendar_home_found": home_found}


@router.get("/calendars")
def list_calendars(db: Session = Depends(get_db)) -> dict[str, Any]:
    apple_id, password = services.icloud_credentials(db)
    pair_by_id = {calendar_id(url): pid for pid, url in db.execute(select(SyncPair.id, SyncPair.source_calendar_url)).all()}
    try:
        with services.make_caldav(apple_id, password) as client:
            result = discover(client)
    except ICloudAuthError:
        services.set_credential_status("icloud", "error", "icloud.auth_failed")
        raise
    calendars = []
    for cal in result.calendars:
        data = cal.public()
        data["pair_id"] = pair_by_id.get(cal.id)
        calendars.append(data)
    return {"calendars": calendars}


@router.get("/diagnostics")
def diagnostics(db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        apple_id, password = services.icloud_credentials(db)
    except AppError:
        return diagnose(None)
    with services.make_caldav(apple_id, password) as client:
        result = diagnose(client)
    log_event("info", "icloud", f"icloud.diagnosis.{result['conclusion']}", {}, db=db)
    return result
