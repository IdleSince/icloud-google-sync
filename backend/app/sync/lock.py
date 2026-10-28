"""Prevents parallel sync runs for the same calendar pair.

Two layers: a process-local lock (cheap, covers scheduler + "sync now" in one
process) and a DB lease row (covers several processes/containers sharing the
volume). The lease expires so a crashed process cannot block forever.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select

from ..db import session_scope
from ..models import SyncLock

_local_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()
LEASE = timedelta(minutes=30)


def _local(name: str) -> threading.Lock:
    with _guard:
        return _local_locks.setdefault(name, threading.Lock())


def _try_lease(name: str, owner: str) -> bool:
    now = datetime.now(UTC)
    with session_scope() as db:
        row = db.execute(select(SyncLock).where(SyncLock.name == name)).scalar_one_or_none()
        if row is not None and row.expires_at > now and row.owner != owner:
            return False
        if row is None:
            db.add(SyncLock(name=name, owner=owner, acquired_at=now, expires_at=now + LEASE))
        else:
            row.owner, row.acquired_at, row.expires_at = owner, now, now + LEASE
    return True


def _release(name: str, owner: str) -> None:
    with session_scope() as db:
        db.execute(delete(SyncLock).where(SyncLock.name == name, SyncLock.owner == owner))


@contextmanager
def pair_lock(name: str) -> Iterator[bool]:
    """Yields True when the lock was acquired, False when another run holds it."""
    local = _local(name)
    if not local.acquire(blocking=False):
        yield False
        return
    owner = uuid.uuid4().hex
    try:
        try:
            acquired = _try_lease(name, owner)
        except Exception:
            acquired = False
        if not acquired:
            yield False
            return
        try:
            yield True
        finally:
            _release(name, owner)
    finally:
        local.release()


def is_locked(name: str) -> bool:
    return _local(name).locked()
