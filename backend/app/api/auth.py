from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import AppError
from ..logging_setup import log_event
from ..security import check_origin, client_key, create_session, current_session, destroy_session, throttle, verify_admin

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=255)
    password: str = Field(min_length=1, max_length=1024)


@router.get("/session")
def session_info(request: Request, db: Session = Depends(get_db)) -> dict[str, object]:
    session = current_session(request, db)
    if session is None:
        return {"authenticated": False, "username": None, "csrf_token": None}
    return {"authenticated": True, "username": session.username, "csrf_token": session.csrf_token}


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response, db: Session = Depends(get_db)) -> dict[str, object]:
    check_origin(request)
    client = client_key(request)
    wait = throttle.retry_after(client)
    if wait:
        raise AppError("auth.rate_limited", 429, {"retry_after_seconds": wait})
    if not verify_admin(body.username, body.password):
        throttle.failed(client)
        log_event("warning", "auth", "auth.invalid_credentials", {})  # own session: the request rolls back
        raise AppError("auth.invalid_credentials", 401)
    throttle.succeeded(client)
    old = current_session(request, db)
    if old is not None:
        db.delete(old)  # session fixation: always issue a fresh session
    session = create_session(db, response, body.username)
    log_event("info", "auth", "auth.login", {}, db=db)
    return {"authenticated": True, "username": session.username, "csrf_token": session.csrf_token}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> Response:
    session = current_session(request, db)
    if session is not None:
        token = request.headers.get("x-csrf-token", "")
        if token != session.csrf_token:
            raise AppError("auth.csrf_invalid", 403)
    destroy_session(request, response, db)
    response.status_code = 204
    return response
