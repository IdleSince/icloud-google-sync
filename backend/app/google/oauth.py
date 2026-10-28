"""Google OAuth 2.0 (authorization code + PKCE, offline access) and token storage."""

from __future__ import annotations

import base64
import hashlib
import threading
from datetime import UTC, datetime, timedelta
from typing import Any, cast
from urllib.parse import urlencode

import httpx
from sqlalchemy.orm import Session

from ..config import Settings
from ..crypto import decrypt, encrypt, random_token
from ..db import session_scope
from ..errors import AppError, GoogleReauthRequired
from ..http_retry import send_with_retry
from ..models import Credential

SCOPE_APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created"
SCOPE_CALENDARLIST_RO = "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
SCOPE_EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned"

BASE_SCOPES = [SCOPE_APP_CREATED, SCOPE_CALENDARLIST_RO]
EXTENDED_SCOPES = [*BASE_SCOPES, SCOPE_EVENTS_OWNED]

PROVIDER = "google"


def pkce_pair() -> tuple[str, str]:
    verifier = random_token(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    return verifier, challenge


def authorization_url(settings: Settings, state: str, challenge: str, extended: bool) -> str:
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.google_redirect_uri,
        "response_type": "code",
        "scope": " ".join(EXTENDED_SCOPES if extended else BASE_SCOPES),
        "access_type": "offline",
        "prompt": "consent",  # guarantees a refresh token
        "include_granted_scopes": "true",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{settings.google_auth_url}?{urlencode(params)}"


class GoogleOAuth:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None) -> None:
        self.settings = settings
        self._client = httpx.Client(timeout=httpx.Timeout(20.0, connect=10.0), transport=transport)

    def close(self) -> None:
        self._client.close()

    def _post(self, url: str, data: dict[str, str]) -> httpx.Response:
        try:
            return send_with_retry(lambda: self._client.post(url, data=data), attempts=4)
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            raise AppError("google.oauth_failed", 502, {"reason": type(exc).__name__}) from exc

    def exchange_code(self, code: str, verifier: str) -> dict[str, Any]:
        response = self._post(
            self.settings.google_token_url,
            {
                "code": code,
                "client_id": self.settings.google_client_id or "",
                "client_secret": self.settings.google_client_secret or "",
                "redirect_uri": self.settings.google_redirect_uri,
                "grant_type": "authorization_code",
                "code_verifier": verifier,
            },
        )
        if response.status_code != 200:
            raise AppError("google.oauth_failed", 502, {"status": response.status_code})
        return cast(dict[str, Any], response.json())

    def refresh(self, refresh_token: str) -> dict[str, Any]:
        response = self._post(
            self.settings.google_token_url,
            {
                "client_id": self.settings.google_client_id or "",
                "client_secret": self.settings.google_client_secret or "",
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        if response.status_code in (400, 401):
            error = ""
            try:
                error = response.json().get("error", "")
            except ValueError:
                pass
            if error in ("invalid_grant", "unauthorized_client", "invalid_client") or response.status_code == 401:
                raise GoogleReauthRequired()
        if response.status_code != 200:
            raise AppError("google.oauth_failed", 502, {"status": response.status_code})
        return cast(dict[str, Any], response.json())

    def revoke(self, token: str) -> bool:
        try:
            response = self._client.post(self.settings.google_revoke_url, data={"token": token})
        except httpx.HTTPError:
            return False
        return response.status_code == 200


class TokenProvider:
    """Hands out valid access tokens, refreshing (and persisting) them when needed."""

    _lock = threading.Lock()

    def __init__(self, oauth: GoogleOAuth) -> None:
        self.oauth = oauth

    def _load(self, db: Session) -> Credential:
        cred = db.get(Credential, PROVIDER)
        if cred is None or not cred.secret_enc:
            raise AppError("google.not_connected", 409)
        if cred.status == "reauth_required":
            raise GoogleReauthRequired()
        return cred

    def access_token(self, force_refresh: bool = False) -> str:
        with self._lock, session_scope() as db:
            cred = self._load(db)
            now = datetime.now(UTC)
            if not force_refresh and cred.access_token_enc and cred.access_expires_at and cred.access_expires_at - now > timedelta(seconds=60):
                return decrypt(cred.access_token_enc, "google.access_token")
            refresh_token = decrypt(cred.secret_enc or "", "google.refresh_token")
            try:
                data = self.oauth.refresh(refresh_token)
            except GoogleReauthRequired:
                cred.status = "reauth_required"
                cred.last_error_code = "google.reauth_required"
                cred.access_token_enc = None
                raise
            cred.access_token_enc = encrypt(data["access_token"], "google.access_token")
            cred.access_expires_at = now + timedelta(seconds=int(data.get("expires_in", 3600)))
            if data.get("refresh_token"):  # Google may rotate it
                cred.secret_enc = encrypt(data["refresh_token"], "google.refresh_token")
            if data.get("scope"):
                cred.scopes = data["scope"]
            return str(data["access_token"])


def store_tokens(db: Session, data: dict[str, Any], account: str | None) -> Credential:
    if not data.get("refresh_token"):
        raise AppError("google.oauth_failed", 502, {"reason": "no_refresh_token"})
    cred = db.get(Credential, PROVIDER) or Credential(provider=PROVIDER)
    cred.secret_enc = encrypt(data["refresh_token"], "google.refresh_token")
    cred.access_token_enc = encrypt(data["access_token"], "google.access_token")
    cred.access_expires_at = datetime.now(UTC) + timedelta(seconds=int(data.get("expires_in", 3600)))
    cred.scopes = data.get("scope", "")
    cred.account_enc = encrypt(account, "google.account") if account else None
    cred.status = "ok"
    cred.last_error_code = None
    cred.last_checked_at = datetime.now(UTC)
    db.add(cred)
    return cred


def granted_scopes(cred: Credential | None) -> set[str]:
    return set((cred.scopes or "").split()) if cred else set()
