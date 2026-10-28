"""Container-friendly structured logging plus the user-visible event log.

Privacy rules: never log passwords, tokens, Authorization headers, event titles,
descriptions or locations. Event identity is logged as a short hash only.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any

from .crypto import sha256_hex

_REDACT = [
    (re.compile(r"(?i)(authorization:\s*)(\S+\s*\S*)"), r"\1[redacted]"),
    (re.compile(r"(?i)(\"?(?:access_token|refresh_token|id_token|client_secret|password|code)\"?\s*[:=]\s*\"?)([^\"&\s,]+)"), r"\1[redacted]"),
    (re.compile(r"\b[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}\b"), "[redacted]"),  # Apple app passwords
]


def redact(text: str) -> str:
    for pattern, repl in _REDACT:
        text = pattern.sub(repl, text)
    return text


def short_hash(value: str) -> str:
    return sha256_hex(value)[:12]


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": redact(record.getMessage()),
        }
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            payload.update({k: v for k, v in extra.items() if k not in payload})
        if record.exc_info:
            payload["exc"] = redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False, default=str)


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # httpx logs full URLs at INFO (OAuth codes could appear) -> keep them quiet.
    for noisy in ("httpx", "httpcore", "apscheduler", "uvicorn.access", "alembic.runtime.plugins"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def log_event(level: str, category: str, code: str, params: dict[str, Any] | None = None, db: Any = None) -> None:
    """Writes a user-visible log entry (codes only) and mirrors it to the container log.

    Pass the caller's ``db`` session when one is open: a second SQLite connection
    would otherwise wait for the caller's write lock.
    """
    from .db import session_scope
    from .models import LogEntry

    safe_params = params or {}
    logging.getLogger(f"icgs.{category}").log(getattr(logging, level.upper(), logging.INFO), code, extra={"fields": {"code": code, **safe_params}})
    entry = LogEntry(level=level, category=category, code=code, params=safe_params)
    if db is not None:
        db.add(entry)
        return
    try:
        with session_scope() as own:
            own.add(entry)
    except Exception:  # logging must never break the caller
        logging.getLogger(__name__).exception("could not persist log entry")
