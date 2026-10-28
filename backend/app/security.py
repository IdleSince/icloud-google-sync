"""Admin login, server-side sessions, CSRF protection, login throttling."""

from __future__ import annotations

import hmac
import threading
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from fastapi import Depends, Request, Response
from sqlalchemy import delete
from sqlalchemy.orm import Session

from .config import get_settings
from .crypto import random_token, sha256_hex
from .db import get_db
from .errors import AppError
from .models import UserSession

UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

_hasher = PasswordHasher()
_admin_hash: str | None = None
_hash_lock = threading.Lock()


def cookie_name() -> str:
    # The __Host- prefix forces Secure + Path=/ + no Domain; only possible over https.
    return "__Host-icgs_session" if get_settings().secure_cookies else "icgs_session"


def _admin_password_hash() -> str | None:
    global _admin_hash
    with _hash_lock:
        if _admin_hash is None:
            password = get_settings().admin_password
            if password:
                _admin_hash = _hasher.hash(password)
        return _admin_hash


def reset_admin_hash() -> None:
    global _admin_hash
    _admin_hash = None


def verify_admin(username: str, password: str) -> bool:
    expected_hash = _admin_password_hash()
    user_ok = hmac.compare_digest(username.encode(), get_settings().admin_username.encode())
    if expected_hash is None:
        return False
    pw_ok: bool
    try:
        pw_ok = _hasher.verify(expected_hash, password)
    except (VerifyMismatchError, VerificationError):
        pw_ok = False
    return user_ok and pw_ok


class LoginThrottle:
    """Per-client and global sliding windows of failed logins."""

    def __init__(self, per_client: int = 5, global_limit: int = 50, window: float = 900.0) -> None:
        self.per_client, self.global_limit, self.window = per_client, global_limit, window
        self._clients: dict[str, deque[float]] = {}
        self._global: deque[float] = deque()
        self._lock = threading.Lock()

    def _trim(self, q: deque[float], now: float) -> None:
        while q and now - q[0] > self.window:
            q.popleft()

    def retry_after(self, client: str) -> int:
        now = time.monotonic()
        with self._lock:
            q = self._clients.get(client, deque())
            self._trim(q, now)
            self._trim(self._global, now)
            if len(q) >= self.per_client:
                return int(self.window - (now - q[0])) + 1
            if len(self._global) >= self.global_limit:
                return int(self.window - (now - self._global[0])) + 1
            return 0

    def failed(self, client: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._clients.setdefault(client, deque()).append(now)
            self._global.append(now)

    def succeeded(self, client: str) -> None:
        with self._lock:
            self._clients.pop(client, None)

    def reset(self) -> None:
        with self._lock:
            self._clients.clear()
            self._global.clear()


throttle = LoginThrottle()


def client_key(request: Request) -> str:
    # uvicorn --proxy-headers already resolves X-Forwarded-For from trusted proxies.
    return request.client.host if request.client else "unknown"


def check_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if origin is None:
        referer = request.headers.get("referer")
        origin = f"{urlparse(referer).scheme}://{urlparse(referer).netloc}" if referer else None
    if origin is None:
        return  # non-browser clients; CSRF token still required for sessions
    expected = urlparse(get_settings().app_base_url)
    got = urlparse(origin)
    if (got.scheme, got.netloc) != (expected.scheme, expected.netloc):
        raise AppError("auth.csrf_invalid", 403)


def create_session(db: Session, response: Response, username: str) -> UserSession:
    token = random_token(32)
    now = datetime.now(UTC)
    session = UserSession(
        token_hash=sha256_hex(token),
        username=username,
        csrf_token=random_token(24),
        created_at=now,
        expires_at=now + timedelta(hours=get_settings().session_ttl_hours),
        last_seen_at=now,
    )
    db.add(session)
    db.execute(delete(UserSession).where(UserSession.expires_at < now))
    response.set_cookie(
        cookie_name(),
        token,
        max_age=get_settings().session_ttl_hours * 3600,
        httponly=True,
        secure=get_settings().secure_cookies,
        samesite="lax",  # lax: the Google OAuth redirect back to us is a top-level GET
        path="/",
    )
    return session


def current_session(request: Request, db: Session) -> UserSession | None:
    token = request.cookies.get(cookie_name())
    if not token:
        return None
    session = db.get(UserSession, sha256_hex(token))
    if session is None:
        return None
    now = datetime.now(UTC)
    if session.expires_at <= now:
        db.delete(session)
        return None
    if now - session.last_seen_at > timedelta(minutes=5):
        session.last_seen_at = now
    return session


def destroy_session(request: Request, response: Response, db: Session) -> None:
    session = current_session(request, db)
    if session is not None:
        db.delete(session)
    response.delete_cookie(cookie_name(), path="/", secure=get_settings().secure_cookies, httponly=True, samesite="lax")


def require_admin(request: Request, db: Session = Depends(get_db)) -> UserSession:
    """Dependency for every administrative endpoint: valid session + CSRF on mutations."""
    session = current_session(request, db)
    if session is None:
        raise AppError("auth.required", 401)
    if request.method in UNSAFE_METHODS:
        check_origin(request)
        token = request.headers.get("x-csrf-token", "")
        if not token or not hmac.compare_digest(token, session.csrf_token):
            raise AppError("auth.csrf_invalid", 403)
    return session
