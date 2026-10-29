"""Several shared iCloud calendars, each mirrored into its own Google calendar."""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app import services
from app.db import session_scope
from app.main import create_app
from app.models import EventMapping, SyncPair, SyncRun
from app.sync.engine import RunOptions

from .conftest import TARGET
from .fakes import HOME, FakeCalendar, FakeGoogle, FakeICloud, ics, vevent
from .test_api import login

pytestmark = pytest.mark.usefixtures("configured")

WORK_PATH = HOME + "shared-work/"
WORK_URL = f"https://p42-caldav.icloud.com{WORK_PATH}"
WORK_TARGET = "work456@group.calendar.google.com"


@pytest.fixture
def work(icloud: FakeICloud, google: FakeGoogle) -> FakeCalendar:
    cal = icloud.add_calendar(FakeCalendar(path=WORK_PATH, name="Arbeit", shared=True, owner_name="Anna Beispiel", privileges=("read", "write")))
    google.add_calendar(WORK_TARGET, summary="Arbeit (anna@example.com)")
    with session_scope() as db:
        db.add(
            SyncPair(
                id=2,
                enabled=True,
                source_calendar_url=WORK_URL,
                source_calendar_name="Arbeit",
                source_calendar_owner="anna@example.com",
                source_calendar_shared=True,
                target_calendar_id=WORK_TARGET,
                target_calendar_name="Arbeit (anna@example.com)",
                target_is_primary=False,
            )
        )
    return cal


def runs(ids: list[int]) -> list[SyncRun]:
    with session_scope() as db:
        rows = [db.get(SyncRun, i) for i in ids]
        db.expunge_all()
    assert all(r is not None for r in rows)
    return [r for r in rows if r is not None]


def test_each_pair_syncs_into_its_own_calendar(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar, work: FakeCalendar) -> None:
    icloud.put_event(source, "f.ics", ics(vevent("f@test", "20261201T090000", "20261201T100000", "Familienfeier")))
    icloud.put_event(work, "w1.ics", ics(vevent("w1@test", "20261202T090000", "20261202T100000", "Schicht")))
    icloud.put_event(work, "w2.ics", ics(vevent("w2@test", "20261203T090000", "20261203T100000", "Schicht")))

    result = runs(services.execute_run(RunOptions(trigger="manual", force_full=True)))
    assert [(r.pair_id, r.calendar_name, r.status, r.created) for r in result] == [(1, "Familie", "success", 1), (2, "Arbeit", "success", 2)]
    assert [e["summary"] for e in google.live_events(TARGET).values()] == ["Familienfeier"]
    assert sorted(e["summary"] for e in google.live_events(WORK_TARGET).values()) == ["Schicht", "Schicht"]

    # Same UID in two calendars must not collide: ids are derived from the pair.
    icloud.put_event(work, "dup.ics", ics(vevent("f@test", "20261204T090000", "20261204T100000", "Gleiche UID")))
    again = runs(services.execute_run(RunOptions(trigger="manual", force_full=True)))
    assert [r.created for r in again] == [0, 1]
    assert len(google.live_events(TARGET)) == 1 and len(google.live_events(WORK_TARGET)) == 3


def test_failing_pair_does_not_stop_the_others(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar, work: FakeCalendar) -> None:
    icloud.put_event(work, "w.ics", ics(vevent("w@test", "20261202T090000", "20261202T100000", "Schicht")))
    del icloud.calendars[source.path]  # the shared "Familie" calendar was unshared
    result = runs(services.execute_run(RunOptions(trigger="manual", force_full=True)))
    assert [(r.pair_id, r.status, r.message_code) for r in result] == [(1, "failed", "icloud.calendar_not_found"), (2, "success", "sync.success")]
    assert len(google.live_events(WORK_TARGET)) == 1


def test_auth_failure_stops_all_pairs(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar, work: FakeCalendar) -> None:
    run_ids = services.start_manual_run(False, False)
    assert len(run_ids) == 2
    services.join_threads(10)
    assert {r.status for r in runs(run_ids)} == {"success"}

    from app.crypto import encrypt
    from app.models import Credential

    with session_scope() as db:
        cred = db.get(Credential, "icloud")
        assert cred is not None
        cred.secret_enc = encrypt("wrong-pass-word-xxxx", "icloud.app_password")
    run_ids = services.start_manual_run(False, False)
    services.join_threads(10)
    assert [(r.status, r.message_code) for r in runs(run_ids)] == [("failed", "icloud.auth_failed")] * 2


def test_disabled_pair_is_skipped_and_ctag_skip_is_per_pair(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar, work: FakeCalendar) -> None:
    icloud.put_event(source, "f.ics", ics(vevent("f@test", "20261201T090000", "20261201T100000", "Familienfeier")))
    icloud.put_event(work, "w.ics", ics(vevent("w@test", "20261202T090000", "20261202T100000", "Schicht")))
    services.execute_run(RunOptions(trigger="schedule"))

    # Only the work calendar changes -> only that pair writes a run.
    icloud.put_event(work, "w2.ics", ics(vevent("w2@test", "20261203T090000", "20261203T100000", "Schicht 2")))
    result = runs(services.execute_run(RunOptions(trigger="schedule")))
    assert [(r.pair_id, r.created) for r in result] == [(2, 1)]

    with session_scope() as db:
        pair = db.get(SyncPair, 2)
        assert pair is not None
        pair.enabled = False
    icloud.put_event(work, "w3.ics", ics(vevent("w3@test", "20261204T090000", "20261204T100000", "Schicht 3")))
    assert services.execute_run(RunOptions(trigger="schedule")) == []
    assert len(google.live_events(WORK_TARGET)) == 2


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(create_app(), base_url="http://testserver") as c:
        yield c


def test_adding_a_calendar_creates_a_named_google_calendar(client: TestClient, icloud: FakeICloud, google: FakeGoogle) -> None:
    h = {"X-CSRF-Token": login(client)}
    icloud.add_calendar(FakeCalendar(path=WORK_PATH, name="Arbeit", shared=True, owner_name="Anna Beispiel"))
    cals = {c["name"]: c for c in client.get("/api/icloud/calendars").json()["calendars"]}
    assert cals["Familie"]["pair_id"] == 1 and cals["Arbeit"]["pair_id"] is None

    r = client.post("/api/pairs", json={"calendar_url": cals["Arbeit"]["url"]}, headers=h)
    assert r.status_code == 201, r.text
    pair = r.json()["pair"]
    assert pair["target"]["name"] == "Arbeit (Anna Beispiel)", "Google is connected -> target created right away"
    assert any(c["summary"] == "Arbeit (Anna Beispiel)" for c in google.calendars.values())

    # A Google calendar can only belong to one pair.
    r = client.put(f"/api/pairs/{pair['id']}/target", json={"calendar_id": TARGET}, headers=h)
    assert r.json()["error"]["code"] == "google.target_in_use"

    listed = client.get("/api/pairs").json()["pairs"]
    assert [p["source"]["name"] for p in listed] == ["Familie", "Arbeit"]

    # Disabling and removing never touch Google or iCloud.
    writes_before = len(google.writes())
    assert client.patch(f"/api/pairs/{pair['id']}", json={"enabled": False}, headers=h).json()["pair"]["enabled"] is False
    assert client.delete(f"/api/pairs/{pair['id']}", headers=h).status_code == 204
    assert len(google.writes()) == writes_before
    assert [p["id"] for p in client.get("/api/pairs").json()["pairs"]] == [1]
    assert client.delete("/api/pairs/99", headers=h).json()["error"]["code"] == "pair.not_found"


def test_removing_a_pair_keeps_history_and_drops_mappings(client: TestClient, icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    h = {"X-CSRF-Token": login(client)}
    icloud.put_event(source, "f.ics", ics(vevent("f@test", "20261201T090000", "20261201T100000", "Familienfeier")))
    run_ids = client.post("/api/sync/runs", json={}, headers=h).json()["run_ids"]
    services.join_threads(10)
    assert client.get("/api/status").json()["pairs"][0]["mapped_events"] == 1
    assert client.delete("/api/pairs/1", headers=h).status_code == 204
    with session_scope() as db:
        assert db.execute(select(EventMapping)).scalars().all() == []
        run = db.get(SyncRun, run_ids[0])
        assert run is not None and run.pair_id is None and run.calendar_name == "Familie"
    assert len(google.live_events(TARGET)) == 1, "events in Google stay untouched"
    assert client.post("/api/sync/runs", json={}, headers=h).json()["error"]["code"] == "sync.not_configured"
