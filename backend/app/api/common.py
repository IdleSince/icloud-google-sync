from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ..models import LogEntry, SyncRun


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def mask_email(value: str | None) -> str | None:
    if not value:
        return None
    local, _, domain = value.partition("@")
    visible = local[:2] if len(local) > 2 else local[:1]
    return f"{visible}***@{domain}" if domain else f"{visible}***"


def run_summary(run: SyncRun) -> dict[str, Any]:
    duration = None
    if run.finished_at and run.started_at:
        duration = int((run.finished_at - run.started_at).total_seconds() * 1000)
    return {
        "id": run.id,
        "trigger": run.trigger,
        "dry_run": run.dry_run,
        "status": run.status,
        "started_at": iso(run.started_at),
        "finished_at": iso(run.finished_at),
        "duration_ms": duration,
        "counts": {"created": run.created, "updated": run.updated, "deleted": run.deleted, "unchanged": run.unchanged, "failed": run.failed},
        "deletions": {
            "planned": run.deletions_planned,
            "executed": run.deleted,
            "blocked": run.deletions_blocked,
            "dry_run": run.deletions_dry_run,
        },
        "source_events": run.source_events,
        "message": {"code": run.message_code, "params": run.message_params or {}},
    }


def run_detail(run: SyncRun) -> dict[str, Any]:
    data = run_summary(run)
    data["items"] = [
        {
            "action": item.action,
            "title": item.title,
            "start": item.start_repr,
            "recurrence_id": item.recurrence_id,
            "planned_only": item.planned_only,
            "error": {"code": item.error_code, "params": item.error_params or {}} if item.error_code else None,
        }
        for item in run.items
    ]
    return data


def log_entry(entry: LogEntry) -> dict[str, Any]:
    return {"id": entry.id, "ts": iso(entry.ts), "level": entry.level, "category": entry.category, "code": entry.code, "params": entry.params or {}}
