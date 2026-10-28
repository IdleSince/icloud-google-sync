from __future__ import annotations

import httpx
import pytest

from app.caldav.client import CalDAVClient, parse_multistatus
from app.caldav.discovery import calendar_id, diagnose, discover
from app.errors import ICloudAuthError, ICloudUnexpected

from .conftest import SOURCE_PATH
from .fakes import APP_PASSWORD, APPLE_ID, HOME, FakeCalendar, FakeICloud, ics, vevent


def client(fake: FakeICloud, password: str = APP_PASSWORD) -> CalDAVClient:
    return CalDAVClient(APPLE_ID, password, transport=fake.transport())


def test_shared_calendar_is_listed_with_owner_and_access(icloud: FakeICloud) -> None:
    icloud.put_event(icloud.calendars[SOURCE_PATH], "a.ics", ics(vevent("a", "20261201T090000", "20261201T100000")))
    with client(icloud) as c:
        result = discover(c)
    by_name = {cal.name: cal for cal in result.calendars}
    shared = by_name["Familie"]
    assert shared.ownership == "shared"
    assert shared.owner == "Anna Beispiel"
    assert shared.access == "read"
    assert shared.readable and shared.event_count == 1
    assert shared.color == "#FF2968"
    own = by_name["Privat"]
    assert own.ownership == "own" and own.access == "read_write"
    assert result.calendars[0].name == "Familie", "shared calendars come first"


def test_calendar_id_is_stable_and_order_independent() -> None:
    a = calendar_id("https://p42-caldav.icloud.com/1/calendars/ABC/")
    assert a == calendar_id("https://p99-caldav.icloud.com/1/calendars/ABC")  # host/trailing slash independent
    assert a != calendar_id("https://p42-caldav.icloud.com/1/calendars/ABD/")


def test_reminder_lists_are_marked_without_events(icloud: FakeICloud) -> None:
    icloud.add_calendar(FakeCalendar(path=HOME + "tasks/", name="Erinnerungen", components=("VTODO",)))
    with client(icloud) as c:
        cal = next(x for x in discover(c).calendars if x.name == "Erinnerungen")
    assert not cal.supports_events
    assert cal.error == {"code": "icloud.calendar_no_events", "params": {}}


def test_diagnosis_shared_accessible(icloud: FakeICloud) -> None:
    with client(icloud) as c:
        result = diagnose(c)
    assert result["conclusion"] == "shared_accessible"
    steps = {s["key"]: s for s in result["steps"]}
    assert steps["calendars"]["params"] == {"total": 2, "own": 1, "shared": 1}
    assert steps["shared_readable"]["status"] == "ok"
    assert all("password" not in str(raw).lower() for raw in result["raw"])


def test_diagnosis_without_shared_calendar(icloud: FakeICloud) -> None:
    del icloud.calendars[SOURCE_PATH]
    with client(icloud) as c:
        result = diagnose(c)
    assert result["conclusion"] == "shared_not_listed"


def test_diagnosis_shared_not_readable(icloud: FakeICloud) -> None:
    icloud.calendars[SOURCE_PATH].readable = False
    with client(icloud) as c:
        result = diagnose(c)
    assert result["conclusion"] == "shared_not_readable"
    shared = next(x for x in result["calendars"] if x["ownership"] == "shared")
    assert not shared["readable"] and shared["error"]["code"] == "icloud.unexpected_response"


def test_diagnosis_auth_failed(icloud: FakeICloud) -> None:
    with client(icloud, password="wrong-wron-gwro-ngxx") as c:
        result = diagnose(c)
    assert result["conclusion"] == "auth_failed"
    with client(icloud, password="wrong-wron-gwro-ngxx") as c, pytest.raises(ICloudAuthError):
        c.current_user_principal()


def test_diagnosis_not_configured() -> None:
    assert diagnose(None)["conclusion"] == "not_configured"


def test_unreachable_icloud(icloud: FakeICloud) -> None:
    icloud.fail_status = 503
    with client(icloud) as c:
        assert diagnose(c)["conclusion"] == "unreachable"


def test_credentials_never_follow_foreign_redirects(icloud: FakeICloud) -> None:
    icloud.redirect_host = "evil.example.com"
    with client(icloud) as c, pytest.raises(ICloudUnexpected) as exc:
        c.current_user_principal()
    assert exc.value.params["reason"] == "foreign_redirect"
    assert "evil.example.com" not in icloud.hosts, "credentials must never be sent to a foreign host"


def test_multistatus_parser_rejects_entities() -> None:
    evil = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><d:multistatus xmlns:d="DAV:">&a;</d:multistatus>'
    with pytest.raises(ICloudUnexpected):
        parse_multistatus(evil)


def test_incomplete_multiget_is_flagged(icloud: FakeICloud) -> None:
    cal = icloud.calendars[SOURCE_PATH]
    icloud.put_event(cal, "a.ics", ics(vevent("a", "20261201T090000", "20261201T100000")))
    icloud.put_event(cal, "b.ics", ics(vevent("b", "20261202T090000", "20261202T100000")))
    icloud.drop_data_for = {"b.ics"}
    from datetime import UTC, datetime

    with client(icloud) as c:
        result = c.fetch_events(f"https://p42-caldav.icloud.com{SOURCE_PATH}", datetime(2026, 1, 1, tzinfo=UTC), datetime(2027, 1, 1, tzinfo=UTC))
    assert not result.complete and "missing_data" in result.problems
    assert len(result.resources) == 1


def test_truncated_listing_is_flagged() -> None:
    body = (
        b'<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">'
        b"<d:response><d:href>/cal/</d:href><d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>"
        b"</d:multistatus>"
    )
    responses = parse_multistatus(body)
    assert responses[0].status == 507

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(207, content=body.replace(b"/cal/", b"/cal/x.ics"))

    from datetime import UTC, datetime

    with CalDAVClient("a@b.c", "x", base_url="https://caldav.icloud.com/", transport=httpx.MockTransport(handler)) as c:
        result = c.fetch_events("https://caldav.icloud.com/cal/", datetime(2026, 1, 1, tzinfo=UTC), datetime(2027, 1, 1, tzinfo=UTC))
    assert not result.complete and "truncated" in result.problems
