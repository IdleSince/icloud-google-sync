"""Database models. Schema changes only via Alembic migrations (alembic/versions)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator[datetime]):
    """Stores timezone-aware datetimes as naive UTC, returns aware UTC datetimes."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Any) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetimes are not allowed, use UTC-aware values")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: datetime | None, dialect: Any) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    pass


class AppSettings(Base):
    """Singleton row (id = 1) with everything the operator configures in the UI."""

    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sync_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    interval_minutes: Mapped[int] = mapped_column(Integer, default=5)
    past_months: Mapped[int] = mapped_column(Integer, default=12)
    future_months: Mapped[int] = mapped_column(Integer, default=24)
    deletion_dry_run: Mapped[bool] = mapped_column(Boolean, default=False)
    deletion_max_absolute: Mapped[int] = mapped_column(Integer, default=25)
    deletion_max_percent: Mapped[int] = mapped_column(Integer, default=30)
    sync_reminders: Mapped[bool] = mapped_column(Boolean, default=True)
    sync_descriptions: Mapped[bool] = mapped_column(Boolean, default=True)
    default_timezone: Mapped[str] = mapped_column(String(64), default="Europe/Berlin")
    allow_primary_target: Mapped[bool] = mapped_column(Boolean, default=False)

    source_calendar_url: Mapped[str | None] = mapped_column(String(1024))
    source_calendar_name: Mapped[str | None] = mapped_column(String(255))
    source_calendar_owner: Mapped[str | None] = mapped_column(String(255))
    source_calendar_shared: Mapped[bool] = mapped_column(Boolean, default=False)

    target_calendar_id: Mapped[str | None] = mapped_column(String(1024))
    target_calendar_name: Mapped[str | None] = mapped_column(String(255))
    target_is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    # Calendars this app created (scope calendar.app.created only covers those).
    created_calendar_ids: Mapped[list[str]] = mapped_column(JSON, default=list)

    # Change detection between runs
    last_source_ctag: Mapped[str | None] = mapped_column(String(255))
    last_config_hash: Mapped[str | None] = mapped_column(String(64))
    last_full_sync_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    last_success_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class Credential(Base):
    """Encrypted credentials. provider = 'icloud' | 'google'."""

    __tablename__ = "credentials"

    provider: Mapped[str] = mapped_column(String(16), primary_key=True)
    account_enc: Mapped[str | None] = mapped_column(Text)
    secret_enc: Mapped[str | None] = mapped_column(Text)  # app password / refresh token
    access_token_enc: Mapped[str | None] = mapped_column(Text)
    access_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    scopes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="unknown")
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    last_checked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)


class EventMapping(Base):
    """One row per synchronized source component (series master, override or single event)."""

    __tablename__ = "event_mappings"
    __table_args__ = (
        UniqueConstraint("source_calendar_url", "target_calendar_id", "uid", "recurrence_id", name="uq_mapping_source"),
        Index("ix_mapping_pair", "source_calendar_url", "target_calendar_id"),
        Index("ix_mapping_google_id", "google_event_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_calendar_url: Mapped[str] = mapped_column(String(1024))
    target_calendar_id: Mapped[str] = mapped_column(String(1024))
    uid: Mapped[str] = mapped_column(String(1024))
    recurrence_id: Mapped[str] = mapped_column(String(32), default="")  # "" = master/single
    source_href: Mapped[str | None] = mapped_column(String(1024))
    source_etag: Mapped[str | None] = mapped_column(String(255))
    google_event_id: Mapped[str] = mapped_column(String(1100))
    kind: Mapped[str] = mapped_column(String(16), default="single")  # single | master | override
    content_hash: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str | None] = mapped_column(String(255))  # shown in run results only (auth protected)
    start_repr: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | error
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, onupdate=utcnow)
    last_synced_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class SyncRun(Base):
    __tablename__ = "sync_runs"
    __table_args__ = (Index("ix_runs_started", "started_at"), Index("ix_runs_status", "status"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    trigger: Mapped[str] = mapped_column(String(16))
    dry_run: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(16), default="running")
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    created: Mapped[int] = mapped_column(Integer, default=0)
    updated: Mapped[int] = mapped_column(Integer, default=0)
    deleted: Mapped[int] = mapped_column(Integer, default=0)
    unchanged: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    deletions_planned: Mapped[int] = mapped_column(Integer, default=0)
    deletions_blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    deletions_dry_run: Mapped[bool] = mapped_column(Boolean, default=False)
    source_events: Mapped[int | None] = mapped_column(Integer)
    message_code: Mapped[str] = mapped_column(String(64), default="sync.success")
    message_params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    source_calendar_url: Mapped[str | None] = mapped_column(String(1024))
    target_calendar_id: Mapped[str | None] = mapped_column(String(1024))

    items: Mapped[list[SyncRunItem]] = relationship(back_populates="run", cascade="all, delete-orphan", passive_deletes=True, order_by="SyncRunItem.id")


class SyncRunItem(Base):
    __tablename__ = "sync_run_items"
    __table_args__ = (Index("ix_items_run", "run_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("sync_runs.id", ondelete="CASCADE"))
    action: Mapped[str] = mapped_column(String(16))
    title: Mapped[str | None] = mapped_column(String(255))
    start_repr: Mapped[str | None] = mapped_column(String(40))
    recurrence_id: Mapped[str | None] = mapped_column(String(32))
    planned_only: Mapped[bool] = mapped_column(Boolean, default=False)
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_params: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    run: Mapped[SyncRun] = relationship(back_populates="items")


class LogEntry(Base):
    """User-visible event log. Contains codes + harmless params only, never secrets or event content."""

    __tablename__ = "log_entries"
    __table_args__ = (Index("ix_logs_ts", "ts"), Index("ix_logs_level", "level"), Index("ix_logs_category", "category"))

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ts: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    level: Mapped[str] = mapped_column(String(16))
    category: Mapped[str] = mapped_column(String(16))
    code: Mapped[str] = mapped_column(String(64))
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


class UserSession(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_expires", "expires_at"),)

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    username: Mapped[str] = mapped_column(String(255))
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class OAuthState(Base):
    __tablename__ = "oauth_states"

    state_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_hash: Mapped[str] = mapped_column(String(64))
    code_verifier_enc: Mapped[str] = mapped_column(Text)
    extended: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())


class SyncLock(Base):
    """Lease lock: prevents parallel runs for the same pair even across processes."""

    __tablename__ = "sync_locks"

    name: Mapped[str] = mapped_column(String(255), primary_key=True)
    owner: Mapped[str] = mapped_column(String(64))
    acquired_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
