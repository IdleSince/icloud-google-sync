"""Exponential backoff with full jitter for outgoing HTTP calls."""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx

RETRY_STATUS = {429, 500, 502, 503, 504}

# Replaced in tests so retries do not slow the suite down.
sleep: Callable[[float], None] = time.sleep


def retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            when = parsedate_to_datetime(value)
            return max(0.0, (when - datetime.now(UTC)).total_seconds())
        except (TypeError, ValueError):
            return None


def backoff_delay(attempt: int, base: float = 0.5, cap: float = 30.0) -> float:
    return random.uniform(0, min(cap, base * (2**attempt)))


def send_with_retry(
    send: Callable[[], httpx.Response],
    *,
    attempts: int = 5,
    should_retry: Callable[[httpx.Response], bool] | None = None,
    cancel: threading.Event | None = None,
) -> httpx.Response:
    """Calls ``send`` until it returns a non-retryable response or attempts are exhausted.

    Network errors are retried as well; the last one is re-raised.
    """
    last_exc: Exception | None = None
    response: httpx.Response | None = None
    for attempt in range(attempts):
        if cancel is not None and cancel.is_set():
            break
        try:
            response = send()
        except (httpx.TransportError, httpx.TimeoutException) as exc:
            last_exc = exc
            response = None
        else:
            retry = response.status_code in RETRY_STATUS or (should_retry is not None and should_retry(response))
            if not retry:
                return response
        if attempt == attempts - 1:
            break
        delay = backoff_delay(attempt)
        if response is not None:
            hinted = retry_after_seconds(response)
            if hinted is not None:
                delay = min(max(delay, hinted), 120.0)
        sleep(delay)
    if response is not None:
        return response
    assert last_exc is not None
    raise last_exc
