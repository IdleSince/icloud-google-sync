"""APScheduler wrapper: one interval job, rescheduled when the interval changes."""

from __future__ import annotations

import logging
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from . import services

log = logging.getLogger(__name__)
JOB_ID = "sync"

_scheduler: BackgroundScheduler | None = None


def start(interval_minutes: int) -> None:
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone="UTC", job_defaults={"coalesce": True, "max_instances": 1, "misfire_grace_time": 120})
    _scheduler.add_job(services.scheduled_run, IntervalTrigger(minutes=interval_minutes), id=JOB_ID, replace_existing=True)
    _scheduler.start()
    log.info("scheduler started", extra={"fields": {"interval_minutes": interval_minutes}})


def reschedule(interval_minutes: int) -> None:
    if _scheduler is not None:
        _scheduler.reschedule_job(JOB_ID, trigger=IntervalTrigger(minutes=interval_minutes))


def next_run_at() -> datetime | None:
    if _scheduler is None:
        return None
    job = _scheduler.get_job(JOB_ID)
    return job.next_run_time if job else None


def info() -> dict[str, object]:
    return {
        "running": bool(_scheduler and _scheduler.running),
        "next_run_at": next_run_at(),
        "job_count": len(_scheduler.get_jobs()) if _scheduler else 0,
    }


def shutdown() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=True)
        _scheduler = None
