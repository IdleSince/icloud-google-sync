from __future__ import annotations

import base64
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

os.environ.setdefault("APP_ENCRYPTION_KEY", base64.urlsafe_b64encode(b"k" * 32).decode())
os.environ.setdefault("ADMIN_PASSWORD", "correct horse battery staple")
os.environ.setdefault("RUN_SCHEDULER", "false")
os.environ.setdefault("GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.com")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("APP_BASE_URL", "http://testserver")
os.environ.setdefault("FRONTEND_DIST", str(Path(__file__).parent / "no-frontend"))

from app import http_retry, security, services  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.crypto import encrypt  # noqa: E402
from app.db import reset_engine, run_migrations, session_scope  # noqa: E402
from app.models import AppSettings, Credential  # noqa: E402

from .fakes import APP_PASSWORD, APPLE_ID, HOME, FakeCalendar, FakeGoogle, FakeICloud  # noqa: E402

TARGET = "sync123@group.calendar.google.com"
SOURCE_PATH = HOME + "shared-family/"


@pytest.fixture(autouse=True)
def _database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path.as_posix()}/test.db")
    get_settings.cache_clear()
    reset_engine()
    run_migrations()
    http_retry.sleep = lambda _s: None
    security.throttle.reset()
    security.reset_admin_hash()
    services.shutdown_event.clear()
    yield
    services.caldav_transport = None
    services.google_transport = None
    reset_engine()
    get_settings.cache_clear()


@pytest.fixture
def icloud() -> FakeICloud:
    fake = FakeICloud()
    fake.add_calendar(FakeCalendar(path=HOME + "home/", name="Privat"))
    fake.add_calendar(FakeCalendar(path=SOURCE_PATH, name="Familie", shared=True, owner_name="Anna Beispiel", privileges=("read",)))
    services.caldav_transport = fake.transport()
    return fake


@pytest.fixture
def google() -> FakeGoogle:
    fake = FakeGoogle()
    fake.add_calendar(TARGET)
    services.google_transport = fake.transport()
    return fake


@pytest.fixture
def source(icloud: FakeICloud) -> FakeCalendar:
    return icloud.calendars[SOURCE_PATH]


@pytest.fixture
def configured(icloud: FakeICloud, google: FakeGoogle) -> None:
    """Credentials + source + target stored, like after the setup in the UI."""
    with session_scope() as db:
        db.merge(
            Credential(provider="icloud", account_enc=encrypt(APPLE_ID, "icloud.account"), secret_enc=encrypt(APP_PASSWORD, "icloud.app_password"), status="ok")
        )
        db.merge(
            Credential(
                provider="google",
                secret_enc=encrypt("rt-1", "google.refresh_token"),
                access_token_enc=encrypt(google.access_token, "google.access_token"),
                access_expires_at=datetime.now(UTC) + timedelta(hours=1),
                scopes="https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly",
                status="ok",
            )
        )
        s = db.get(AppSettings, 1) or AppSettings(id=1)
        s.source_calendar_url = f"https://p42-caldav.icloud.com{SOURCE_PATH}"
        s.source_calendar_name = "Familie"
        s.source_calendar_shared = True
        s.target_calendar_id = TARGET
        s.target_calendar_name = "iCloud Sync"
        s.created_calendar_ids = [TARGET]
        db.add(s)
