"""Thin Google Calendar API v3 client (REST via httpx) with retries and token refresh."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from typing import Any, cast
from urllib.parse import quote

import httpx

from ..errors import AppError, GoogleApiError, GoogleRateLimited
from ..http_retry import send_with_retry

RATE_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"}
NO_NOTIFY = {"sendUpdates": "none"}


def _reason(response: httpx.Response) -> str | None:
    try:
        errors = response.json().get("error", {}).get("errors", [])
    except (ValueError, AttributeError):
        return None
    return errors[0].get("reason") if errors else None


class GoogleCalendarClient:
    def __init__(
        self,
        token: Callable[[bool], str],
        *,
        base_url: str = "https://www.googleapis.com/calendar/v3",
        transport: httpx.BaseTransport | None = None,
        cancel: threading.Event | None = None,
    ) -> None:
        self._token = token
        self.base_url = base_url.rstrip("/")
        self.cancel = cancel
        self._client = httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0), transport=transport)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> GoogleCalendarClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _request(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None, ok: tuple[int, ...] = (200,)) -> httpx.Response:
        url = f"{self.base_url}{path}"
        refreshed = False
        while True:
            token = self._token(False)

            def send(tok: str = token) -> httpx.Response:
                return self._client.request(method, url, params=params, json=json, headers={"Authorization": f"Bearer {tok}"})

            try:
                response = send_with_retry(
                    send,
                    attempts=6,
                    should_retry=lambda r: r.status_code == 403 and _reason(r) in RATE_REASONS,
                    cancel=self.cancel,
                )
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                raise GoogleApiError(0, type(exc).__name__) from exc
            if response.status_code == 401 and not refreshed:
                refreshed = True
                self._token(True)  # force refresh, then retry once
                continue
            break
        if response.status_code in ok:
            return response
        reason = _reason(response)
        if response.status_code == 429 or (response.status_code == 403 and reason in RATE_REASONS):
            raise GoogleRateLimited()
        if response.status_code == 403 and reason in ("insufficientPermissions", "forbidden", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"):
            raise AppError("google.scope_missing", 403, {"status": 403})
        raise GoogleApiError(response.status_code, reason)

    @staticmethod
    def _cal(calendar_id: str) -> str:
        return quote(calendar_id, safe="")

    def _paged(self, path: str, params: dict[str, Any]) -> Iterator[dict[str, Any]]:
        token: str | None = None
        while True:
            page = dict(params)
            if token:
                page["pageToken"] = token
            data = self._request("GET", path, params=page).json()
            yield from data.get("items", [])
            token = data.get("nextPageToken")
            if not token:
                return

    # -- calendars -------------------------------------------------------------------

    def list_calendars(self) -> list[dict[str, Any]]:
        return list(self._paged("/users/me/calendarList", {"maxResults": 250, "showHidden": "true"}))

    def get_calendar_entry(self, calendar_id: str) -> dict[str, Any] | None:
        try:
            return cast(dict[str, Any], self._request("GET", f"/users/me/calendarList/{self._cal(calendar_id)}").json())
        except GoogleApiError as exc:
            if exc.http_status in (404, 410):
                return None
            raise

    def create_calendar(self, summary: str, time_zone: str) -> dict[str, Any]:
        return cast(dict[str, Any], self._request("POST", "/calendars", json={"summary": summary, "timeZone": time_zone}).json())

    def account_email(self) -> str | None:
        for entry in self.list_calendars():
            if entry.get("primary"):
                return str(entry.get("id"))
        return None

    # -- events ----------------------------------------------------------------------

    def insert_event(self, calendar_id: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        response = self._request("POST", f"/calendars/{self._cal(calendar_id)}/events", params=NO_NOTIFY, json=body, ok=(200, 409))
        return response.status_code, (response.json() if response.status_code == 200 else {})

    def get_event(self, calendar_id: str, event_id: str) -> dict[str, Any] | None:
        try:
            return cast(dict[str, Any], self._request("GET", f"/calendars/{self._cal(calendar_id)}/events/{quote(event_id, safe='')}").json())
        except GoogleApiError as exc:
            if exc.http_status in (404, 410):
                return None
            raise

    def update_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any] | None:
        response = self._request(
            "PUT", f"/calendars/{self._cal(calendar_id)}/events/{quote(event_id, safe='')}", params=NO_NOTIFY, json=body, ok=(200, 404, 410)
        )
        return response.json() if response.status_code == 200 else None

    def patch_event(self, calendar_id: str, event_id: str, body: dict[str, Any]) -> dict[str, Any] | None:
        response = self._request(
            "PATCH", f"/calendars/{self._cal(calendar_id)}/events/{quote(event_id, safe='')}", params=NO_NOTIFY, json=body, ok=(200, 404, 410)
        )
        return response.json() if response.status_code == 200 else None

    def delete_event(self, calendar_id: str, event_id: str) -> bool:
        """True if deleted now, False if it was already gone."""
        response = self._request("DELETE", f"/calendars/{self._cal(calendar_id)}/events/{quote(event_id, safe='')}", params=NO_NOTIFY, ok=(200, 204, 404, 410))
        return response.status_code in (200, 204)

    def find_instance(self, calendar_id: str, master_id: str, original_start: str) -> dict[str, Any] | None:
        params = {"originalStart": original_start, "showDeleted": "true", "maxResults": 5}
        try:
            data = self._request("GET", f"/calendars/{self._cal(calendar_id)}/events/{quote(master_id, safe='')}/instances", params=params).json()
        except GoogleApiError as exc:
            if exc.http_status in (404, 410):
                return None
            raise
        items = data.get("items", [])
        return items[0] if items else None

    def list_managed_events(self, calendar_id: str, pkey: str) -> list[dict[str, Any]]:
        params = {
            "privateExtendedProperty": f"icgs_pair={pkey}",
            "showDeleted": "false",
            "singleEvents": "false",
            "maxResults": 2500,
            "fields": "items(id,status,recurringEventId,extendedProperties),nextPageToken",
        }
        return list(self._paged(f"/calendars/{self._cal(calendar_id)}/events", params))
