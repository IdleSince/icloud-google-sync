"""In-memory fakes for iCloud CalDAV and the Google Calendar API (httpx MockTransport).

Tests never talk to real Apple or Google servers and never touch real calendars.
"""

from __future__ import annotations

import base64
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, unquote
from xml.sax.saxutils import escape

import httpx

APPLE_ID = "tester@icloud.com"
APP_PASSWORD = "abcd-efgh-ijkl-mnop"
PRINCIPAL = "/123456/principal/"
HOME = "/123456/calendars/"


@dataclass
class FakeCalendar:
    path: str
    name: str
    shared: bool = False
    owner_name: str | None = None
    components: tuple[str, ...] = ("VEVENT",)
    privileges: tuple[str, ...] = ("read", "write")
    readable: bool = True
    ctag: str = "ctag-1"
    events: dict[str, str] = field(default_factory=dict)  # resource name -> ics


class FakeICloud:
    def __init__(self) -> None:
        self.calendars: dict[str, FakeCalendar] = {}
        self.fail_status: int | None = None  # every request answers with this status
        self.report_status: int | None = None
        self.drop_data_for: set[str] = set()  # multiget omits calendar-data for these names
        self.get_status_override: dict[str, int] = {}
        self.requests: list[tuple[str, str]] = []
        self.hosts: list[str] = []
        self.redirect_host = "p42-caldav.icloud.com"

    def add_calendar(self, cal: FakeCalendar) -> FakeCalendar:
        self.calendars[cal.path] = cal
        return cal

    def put_event(self, cal: FakeCalendar, name: str, ics: str) -> None:
        cal.events[name] = ics
        cal.ctag = "ctag-" + uuid.uuid4().hex[:8]

    def remove_event(self, cal: FakeCalendar, name: str) -> None:
        cal.events.pop(name, None)
        cal.ctag = "ctag-" + uuid.uuid4().hex[:8]

    # -- transport -------------------------------------------------------------------
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _ms(self, responses: list[str]) -> httpx.Response:
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" '
            'xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">' + "".join(responses) + "</d:multistatus>"
        )
        return httpx.Response(207, content=body.encode(), headers={"Content-Type": "application/xml"})

    @staticmethod
    def _resp(href: str, props: str, missing: str = "") -> str:
        out = f"<d:response><d:href>{escape(href)}</d:href><d:propstat><d:prop>{props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
        if missing:
            out += f"<d:propstat><d:prop>{missing}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>"
        return out + "</d:response>"

    def _calendar_props(self, cal: FakeCalendar) -> str:
        rtype = "<d:collection/><c:calendar/>" + ("<cs:shared/>" if cal.shared else "")
        privs = "".join(f"<d:privilege><d:{p}/></d:privilege>" for p in cal.privileges)
        comps = "".join(f'<c:comp name="{c}"/>' for c in cal.components)
        props = (
            f"<d:resourcetype>{rtype}</d:resourcetype><d:displayname>{escape(cal.name)}</d:displayname>"
            f"<d:current-user-privilege-set>{privs}</d:current-user-privilege-set>"
            f"<cs:getctag>{cal.ctag}</cs:getctag><c:supported-calendar-component-set>{comps}</c:supported-calendar-component-set>"
            "<ical:calendar-color>#FF2968FF</ical:calendar-color>"
        )
        if cal.shared:
            props += (
                f"<d:owner><d:href>/999999/principal/</d:href></d:owner>"
                f"<cs:shared-url><d:href>/999999/calendars/{cal.path.rsplit('/', 2)[-2]}/</d:href></cs:shared-url>"
                f"<cs:invite><cs:organizer><d:href>mailto:owner@example.org</d:href>"
                f"<cs:common-name>{escape(cal.owner_name or 'Owner')}</cs:common-name></cs:organizer>"
                f"<cs:user><d:href>mailto:{APPLE_ID}</d:href><cs:access><cs:read/></cs:access></cs:user></cs:invite>"
            )
        else:
            props += f"<d:owner><d:href>{PRINCIPAL}</d:href></d:owner>"
        return props

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append((request.method, request.url.path))
        self.hosts.append(request.url.host)
        expected = "Basic " + base64.b64encode(f"{APPLE_ID}:{APP_PASSWORD}".encode()).decode()
        if request.headers.get("authorization") != expected:
            return httpx.Response(401)
        if self.fail_status:
            return httpx.Response(self.fail_status)
        path = request.url.path
        host = request.url.host
        body = request.content.decode() if request.content else ""

        if request.method == "PROPFIND" and path in ("/", "/.well-known/caldav") and host == "caldav.icloud.com":
            return httpx.Response(301, headers={"Location": f"https://{self.redirect_host}/"})
        if request.method == "PROPFIND" and path == "/":
            return self._ms([self._resp("/", f"<d:current-user-principal><d:href>{PRINCIPAL}</d:href></d:current-user-principal>")])
        if request.method == "PROPFIND" and path == PRINCIPAL:
            return self._ms(
                [
                    self._resp(
                        PRINCIPAL,
                        f"<c:calendar-home-set><d:href>https://{self.redirect_host}{HOME}</d:href></c:calendar-home-set><d:displayname>Tester</d:displayname>",
                        "<cs:calendar-proxy-read-for/><cs:calendar-proxy-write-for/>",
                    )
                ]
            )
        if request.method == "PROPFIND" and path == "/999999/principal/":
            return self._ms([self._resp(path, "<d:displayname>Owner Principal</d:displayname>")])
        if request.method == "PROPFIND" and path == HOME:
            items = [self._resp(HOME, "<d:resourcetype><d:collection/></d:resourcetype>")]
            items.append(self._resp(HOME + "inbox/", "<d:resourcetype><d:collection/><c:schedule-inbox/></d:resourcetype>"))
            items += [self._resp(c.path, self._calendar_props(c)) for c in self.calendars.values()]
            return self._ms(items)
        if request.method == "PROPFIND" and path in self.calendars:
            return self._ms([self._resp(path, self._calendar_props(self.calendars[path]))])
        if request.method == "PROPFIND":
            return httpx.Response(404)

        if request.method == "REPORT" and path in self.calendars:
            cal = self.calendars[path]
            if not cal.readable:
                return httpx.Response(403)
            if self.report_status:
                return httpx.Response(self.report_status)
            if "calendar-multiget" in body:
                hrefs = [unquote(h) for h in re.findall(r"<d:href>([^<]+)</d:href>", body)]
                out = []
                for href in hrefs:
                    name = href.rsplit("/", 1)[-1]
                    if name not in cal.events:
                        out.append(f"<d:response><d:href>{escape(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>")
                        continue
                    if name in self.drop_data_for:
                        out.append(self._resp(href, f'<d:getetag>"{hash(cal.events[name])}"</d:getetag>'))
                        continue
                    out.append(
                        self._resp(href, f'<d:getetag>"{hash(cal.events[name])}"</d:getetag><c:calendar-data>{escape(cal.events[name])}</c:calendar-data>')
                    )
                return self._ms(out)
            out = [self._resp(path + name, f'<d:getetag>"{hash(ics)}"</d:getetag>') for name, ics in sorted(cal.events.items())]
            return self._ms(out)

        if request.method == "GET":
            for cal in self.calendars.values():
                if path.startswith(cal.path):
                    name = path[len(cal.path) :]
                    if name in self.get_status_override:
                        return httpx.Response(self.get_status_override[name])
                    if name in cal.events:
                        return httpx.Response(200, text=cal.events[name])
                    return httpx.Response(404)
        return httpx.Response(405)


# ---------------------------------------------------------------------------------------


class FakeGoogle:
    def __init__(self) -> None:
        self.calendars: dict[str, dict[str, Any]] = {
            "me@example.com": {"id": "me@example.com", "summary": "Me", "primary": True, "accessRole": "owner"},
            "readonly@group.calendar.google.com": {"id": "readonly@group.calendar.google.com", "summary": "Holidays", "accessRole": "reader"},
        }
        self.events: dict[str, dict[str, dict[str, Any]]] = {}
        self.instances: dict[str, dict[str, Any]] = {}  # instance id -> overrides
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.access_token = "at-1"
        self.refresh_invalid = False
        self.force_401_once = False
        self.fail_event_ids: dict[str, int] = {}  # event id -> status for writes
        self.rate_limit_next = 0
        self.no_instance_for: set[str] = set()
        self.force_401_on_list_once = False  # 401 on the first managed-events listing

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def add_calendar(self, cal_id: str, summary: str = "iCloud Sync", role: str = "owner") -> None:
        self.calendars[cal_id] = {"id": cal_id, "summary": summary, "accessRole": role}

    def live_events(self, cal_id: str) -> dict[str, dict[str, Any]]:
        return {k: v for k, v in self.events.get(cal_id, {}).items() if v.get("status") != "cancelled"}

    def writes(self) -> list[tuple[str, str, dict[str, Any]]]:
        return [c for c in self.calls if c[0] in ("POST", "PUT", "PATCH", "DELETE") and "/events" in c[1]]

    @staticmethod
    def _json(status: int, data: Any = None) -> httpx.Response:
        return httpx.Response(status, json=data if data is not None else {})

    @staticmethod
    def _error(status: int, reason: str) -> httpx.Response:
        return httpx.Response(status, json={"error": {"code": status, "errors": [{"reason": reason}]}})

    def handle(self, request: httpx.Request) -> httpx.Response:
        url = request.url
        params = {k: v[0] for k, v in parse_qs(url.query.decode()).items()}
        body: dict[str, Any] = {}
        if request.content and request.headers.get("content-type", "").startswith("application/json"):
            body = json.loads(request.content)
        self.calls.append((request.method, url.path, body))

        if url.host == "oauth2.googleapis.com":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            if url.path == "/revoke":
                return self._json(200)
            if form.get("grant_type") == "refresh_token":
                if self.refresh_invalid:
                    return self._json(400, {"error": "invalid_grant"})
                self.access_token = "at-" + uuid.uuid4().hex[:6]
                return self._json(
                    200,
                    {
                        "access_token": self.access_token,
                        "expires_in": 3600,
                        "scope": "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly",
                    },
                )
            if form.get("grant_type") == "authorization_code":
                if form.get("code") != "good-code" or not form.get("code_verifier"):
                    return self._json(400, {"error": "invalid_grant"})
                return self._json(
                    200,
                    {
                        "access_token": self.access_token,
                        "refresh_token": "rt-1",
                        "expires_in": 3600,
                        "scope": "https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/calendar.calendarlist.readonly",
                    },
                )
            return self._json(400, {"error": "unsupported_grant_type"})

        if request.headers.get("authorization") != f"Bearer {self.access_token}" or self.force_401_once:
            self.force_401_once = False
            return self._error(401, "authError")
        if self.rate_limit_next > 0:
            self.rate_limit_next -= 1
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": {"errors": [{"reason": "rateLimitExceeded"}]}})

        path = unquote(url.path.removeprefix("/calendar/v3"))
        if path == "/users/me/calendarList" and request.method == "GET":
            return self._json(200, {"items": list(self.calendars.values())})
        m = re.fullmatch(r"/users/me/calendarList/(.+)", path)
        if m and request.method == "GET":
            cal = self.calendars.get(m.group(1))
            return self._json(200, cal) if cal else self._error(404, "notFound")
        if path == "/calendars" and request.method == "POST":
            cal_id = uuid.uuid4().hex[:10] + "@group.calendar.google.com"
            self.add_calendar(cal_id, body["summary"])
            return self._json(200, {"id": cal_id, "summary": body["summary"], "timeZone": body.get("timeZone")})

        m = re.fullmatch(r"/calendars/([^/]+)/events(?:/([^/]+))?(/instances)?", path)
        if not m:
            return self._error(404, "notFound")
        cal_id, event_id, instances = m.group(1), m.group(2), m.group(3)
        if cal_id not in self.calendars:
            return self._error(404, "notFound")
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            assert params.get("sendUpdates") == "none", "writes must never notify attendees"
            target = event_id or body.get("id")
            if target in self.fail_event_ids:
                return self._error(self.fail_event_ids[target], "backendError")
        store = self.events.setdefault(cal_id, {})

        if instances and request.method == "GET":
            master = store.get(event_id or "")
            if master is None:
                return self._error(404, "notFound")
            original = params["originalStart"]
            if event_id in self.no_instance_for:
                return self._json(200, {"items": []})
            stamp = original.replace("-", "").replace(":", "")
            inst_id = f"{event_id}_{stamp}"
            data = {"id": inst_id, "recurringEventId": event_id, "originalStartTime": {"dateTime": original}, **self.instances.get(inst_id, {})}
            return self._json(200, {"items": [data]})

        if event_id is None and request.method == "POST":
            new_id = body.get("id") or uuid.uuid4().hex
            if "attendees" in body:
                raise AssertionError("attendees must never be sent")
            if new_id in store:
                return self._error(409, "duplicate")
            store[new_id] = {**body, "id": new_id, "status": body.get("status", "confirmed")}
            return self._json(200, store[new_id])
        if event_id is None and request.method == "GET" and self.force_401_on_list_once:
            self.force_401_on_list_once = False
            return self._error(401, "authError")
        if event_id is None and request.method == "GET":
            prop = params.get("privateExtendedProperty", "")
            key, _, value = prop.partition("=")
            items = [
                e
                for e in store.values()
                if e.get("status") != "cancelled" and (not prop or (e.get("extendedProperties", {}).get("private", {}).get(key) == value))
            ]
            return self._json(200, {"items": items})

        assert event_id is not None
        if "_" in event_id and event_id.split("_", 1)[0] in store:  # instance of a series
            if request.method == "PATCH":
                self.instances[event_id] = {**self.instances.get(event_id, {}), **body}
                return self._json(200, {"id": event_id, **self.instances[event_id]})
            if request.method == "GET":
                return self._json(200, {"id": event_id, **self.instances.get(event_id, {})})
            if request.method == "DELETE":
                self.instances[event_id] = {"status": "cancelled"}
                return httpx.Response(204)
        event = store.get(event_id)
        if request.method == "GET":
            return self._json(200, event) if event else self._error(404, "notFound")
        if request.method == "PUT":
            if event is None:
                return self._error(404, "notFound")
            store[event_id] = {**body, "id": event_id, "status": body.get("status", "confirmed")}
            return self._json(200, store[event_id])
        if request.method == "PATCH":
            if event is None:
                return self._error(404, "notFound")
            event.update(body)
            return self._json(200, event)
        if request.method == "DELETE":
            if event is None or event.get("status") == "cancelled":
                return self._error(410, "deleted")
            event["status"] = "cancelled"  # Google keeps deleted events as cancelled
            return httpx.Response(204)
        return self._error(405, "methodNotAllowed")


def vevent(uid: str, start: str, end: str | None = None, summary: str = "Termin", extra: str = "", tz: str | None = "Europe/Berlin") -> str:
    def prop(name: str, value: str) -> str:
        if len(value) == 8:
            return f"{name};VALUE=DATE:{value}"
        if value.endswith("Z") or tz is None:
            return f"{name}:{value}"
        return f"{name};TZID={tz}:{value}"

    lines = ["BEGIN:VEVENT", f"UID:{uid}", "DTSTAMP:20260101T000000Z", prop("DTSTART", start)]
    if end:
        lines.append(prop("DTEND", end))
    lines.append(f"SUMMARY:{summary}")
    if extra:
        lines.extend(line for line in extra.strip().splitlines())
    lines.append("END:VEVENT")
    return "\r\n".join(lines)


def ics(*events: str) -> str:
    return "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", *events, "END:VCALENDAR", ""])


def now_utc() -> datetime:
    return datetime.now(UTC)
