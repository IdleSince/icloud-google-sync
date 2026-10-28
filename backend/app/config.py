"""Application configuration.

Secrets can be passed either directly (``NAME``) or as a file path (``NAME_FILE``),
which is how Docker secrets are mounted (``/run/secrets/...``). The ``_FILE``
variant always wins so that secrets never have to live in the environment.
"""

from __future__ import annotations

import base64
import os
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

APP_VERSION = "1.0.0"

_SECRET_NAMES = (
    "APP_ENCRYPTION_KEY",
    "ADMIN_PASSWORD",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CLIENT_ID",
)


def _read_secret_files() -> dict[str, str]:
    values: dict[str, str] = {}
    for name in _SECRET_NAMES:
        path = os.environ.get(f"{name}_FILE")
        if path:
            file = Path(path)
            if file.is_file():
                values[name.lower()] = file.read_text(encoding="utf-8").strip()
    return values


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False)

    app_base_url: str = Field(default="http://localhost:8000")
    database_url: str = Field(default="sqlite:////data/icgs.db")
    log_level: str = Field(default="INFO")

    admin_username: str = Field(default="admin")
    admin_password: str | None = None

    app_encryption_key: str | None = None

    google_client_id: str | None = None
    google_client_secret: str | None = None

    session_ttl_hours: int = Field(default=12, ge=1, le=24 * 30)
    frontend_dist: str = Field(default="/app/frontend/dist")

    icloud_caldav_url: str = Field(default="https://caldav.icloud.com/")
    # Hosts that may receive the Apple credentials. Redirects anywhere else are refused.
    icloud_allowed_host_suffix: str = Field(default=".icloud.com")

    google_api_base: str = Field(default="https://www.googleapis.com/calendar/v3")
    google_auth_url: str = Field(default="https://accounts.google.com/o/oauth2/v2/auth")
    google_token_url: str = Field(default="https://oauth2.googleapis.com/token")
    google_revoke_url: str = Field(default="https://oauth2.googleapis.com/revoke")

    run_scheduler: bool = Field(default=True)

    @field_validator("app_base_url")
    @classmethod
    def _strip_slash(cls, value: str) -> str:
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError("APP_BASE_URL must be an absolute http(s) URL")
        return value.rstrip("/")

    @property
    def secure_cookies(self) -> bool:
        return self.app_base_url.startswith("https://")

    @property
    def google_redirect_uri(self) -> str:
        return f"{self.app_base_url}/api/google/oauth/callback"

    @property
    def google_configured(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    def encryption_key_bytes(self) -> bytes:
        if not self.app_encryption_key:
            raise RuntimeError("APP_ENCRYPTION_KEY (or APP_ENCRYPTION_KEY_FILE) is not set")
        raw = base64.urlsafe_b64decode(self.app_encryption_key + "=" * (-len(self.app_encryption_key) % 4))
        if len(raw) != 32:
            raise RuntimeError("APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded")
        return raw


@lru_cache
def get_settings() -> Settings:
    # Values from *_FILE secrets override the environment; pydantic coerces the strings.
    return Settings(**_read_secret_files())  # type: ignore[arg-type]
