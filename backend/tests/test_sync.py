"""End-to-end sync behaviour against fake iCloud/Google servers."""

from __future__ import annotations

import threading

import pytest
from sqlalchemy import delete, select

from app import services
from app.db import session_scope
from app.models import AppSettings, Credential, EventMapping, SyncRun
from app.sync.engine import RunOptions
from app.sync.lock import pair_lock

from .conftest import TARGET
from .fakes import FakeCalendar, FakeGoogle, FakeICloud, ics, vevent

pytestmark = pytest.mark.usefixtures("configured")


def run(**kwargs: object) -> SyncRun:
    opts = RunOptions(trigger=str(kwargs.pop("trigger", "manual")), force_full=True, **kwargs)  # type: ignore[arg-type]
    run_id = services.execute_run(opts)
    with session_scope() as db:
        if run_id is None:
            row = db.execute(select(SyncRun).order_by(SyncRun.id.desc())).scalars().first()
        else:
            row = db.get(SyncRun, run_id)
        assert row is not None
        stale = db.execute(select(SyncRun).where(SyncRun.status == "running")).scalars().all()
        assert stale == [], "no run may stay 'running' after execute_run returned"
        _ = row.items
        db.expunge_all()
        return row


def settings(**values: object) -> None:
    with session_scope() as db:
        s = db.get(AppSettings, 1)
        assert s is not None
        for k, v in values.items():
            setattr(s, k, v)


def mapping_count() -> int:
    with session_scope() as db:
        return len(db.execute(select(EventMapping)).scalars().all())


def add_events(icloud: FakeICloud, source: FakeCalendar, n: int, prefix: str = "e") -> None:
    for i in range(n):
        icloud.put_event(
            source, f"{prefix}{i}.ics", ics(vevent(f"{prefix}{i}@test", f"202612{(i % 28) + 1:02d}T090000", f"202612{(i % 28) + 1:02d}T100000", f"Termin {i}"))
        )


# -- new / changed / unchanged ------------------------------------------------------------


def test_new_events_are_created_once_and_rerun_is_idempotent(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 3)
    first = run()
    assert first.status == "success"
    assert (first.created, first.updated, first.deleted) == (3, 0, 0)
    assert len(google.live_events(TARGET)) == 3

    writes_before = len(google.writes())
    second = run()
    assert (second.created, second.updated, second.unchanged) == (0, 0, 3)
    assert second.message_code == "sync.unchanged"
    assert len(google.writes()) == writes_before, "an unchanged rerun must not write to Google"
    assert len(google.live_events(TARGET)) == 3


def test_changed_event_updates_instead_of_creating(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    icloud.put_event(source, "a.ics", ics(vevent("a@test", "20261201T090000", "20261201T100000", "Alt")))
    run()
    icloud.put_event(source, "a.ics", ics(vevent("a@test", "20261201T110000", "20261201T120000", "Neu")))
    result = run()
    assert (result.created, result.updated) == (0, 1)
    events = list(google.live_events(TARGET).values())
    assert len(events) == 1
    assert events[0]["summary"] == "Neu"
    assert events[0]["start"]["dateTime"] == "2026-12-01T11:00:00+01:00"


def test_writes_never_contain_attendees_or_notify(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    extra = "ORGANIZER;CN=Anna:mailto:anna@example.org\nATTENDEE;CN=Bob:mailto:bob@example.org"
    icloud.put_event(source, "m.ics", ics(vevent("m@test", "20261203T090000", "20261203T100000", "Meeting", extra)))
    run()
    event = next(iter(google.live_events(TARGET).values()))
    assert "attendees" not in event and "organizer" not in event
    # FakeGoogle asserts sendUpdates=none on every write.


# -- deletions ----------------------------------------------------------------------------


def test_deleted_event_is_removed_from_google(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    icloud.remove_event(source, "e2.ics")
    result = run()
    assert result.deleted == 1
    assert len(google.live_events(TARGET)) == 5
    assert mapping_count() == 5


def test_event_still_existing_outside_window_is_not_deleted(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    # Simulate "no longer returned by the time-range query, but the resource still exists".
    icloud.drop_data_for = set()
    stored = source.events.pop("e1.ics")
    source.ctag = "changed"
    original_get = icloud.handle

    def handle(request):  # type: ignore[no-untyped-def]
        if request.method == "GET" and request.url.path.endswith("e1.ics"):
            import httpx

            return httpx.Response(200, text=stored)
        return original_get(request)

    icloud.handle = handle  # type: ignore[method-assign]
    services.caldav_transport = __import__("httpx").MockTransport(handle)
    result = run()
    assert result.deleted == 0
    assert len(google.live_events(TARGET)) == 6


def test_cancelled_status_in_source_removes_event(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    icloud.put_event(source, "e0.ics", ics(vevent("e0@test", "20261201T090000", "20261201T100000", "x", "STATUS:CANCELLED")))
    result = run()
    assert result.deleted == 1


def test_incomplete_fetch_blocks_all_deletions(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    icloud.remove_event(source, "e0.ics")
    icloud.drop_data_for = {"e3.ics"}  # one resource comes back without data
    result = run()
    assert result.status == "partial"
    assert result.message_code == "sync.source_incomplete"
    assert result.deleted == 0
    assert len(google.live_events(TARGET)) == 6
    assert any(item.action == "skip_delete" for item in result.items)


def test_mass_deletion_guard_blocks_and_can_be_released(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 20)
    run()
    for i in range(10):
        icloud.remove_event(source, f"e{i}.ics")
    blocked = run()
    assert blocked.message_code == "sync.deletion_guard_tripped"
    assert blocked.deletions_blocked and blocked.deletions_planned == 10
    assert blocked.deleted == 0
    assert len(google.live_events(TARGET)) == 20

    released = run(allow_mass_deletion=True)
    assert released.deleted == 10
    assert len(google.live_events(TARGET)) == 10


def test_empty_source_never_wipes_target(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 2)
    run()
    for name in list(source.events):
        icloud.remove_event(source, name)
    result = run()
    assert result.deletions_blocked
    assert len(google.live_events(TARGET)) == 2


def test_deletion_dry_run_setting_only_plans(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    settings(deletion_dry_run=True)
    icloud.remove_event(source, "e0.ics")
    result = run()
    assert result.deleted == 0 and result.deletions_planned == 1 and result.deletions_dry_run
    assert result.message_code == "sync.deletion_dry_run"
    assert len(google.live_events(TARGET)) == 6
    assert [i.action for i in result.items if i.planned_only] == ["delete"]


def test_full_dry_run_never_writes(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 4)
    result = run(dry_run=True, trigger="dry_run")
    assert result.created == 4 and result.dry_run
    assert google.writes() == []
    assert mapping_count() == 0


def test_foreign_event_without_marker_is_never_deleted(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    with session_scope() as db:
        m = db.execute(select(EventMapping).where(EventMapping.uid == "e1@test")).scalar_one()
        gid = m.google_event_id
    google.events[TARGET][gid]["extendedProperties"] = {"private": {}}  # somebody replaced it
    icloud.remove_event(source, "e1.ics")
    result = run()
    assert result.deleted == 0
    assert google.events[TARGET][gid]["status"] == "confirmed"


# -- duplicates / recovery ----------------------------------------------------------------


def test_lost_database_does_not_create_duplicates(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 3)
    run()
    with session_scope() as db:
        db.execute(delete(EventMapping))
    result = run()
    assert result.failed == 0
    assert len(google.live_events(TARGET)) == 3, "deterministic ids must prevent duplicates"
    assert mapping_count() == 3


def test_event_deleted_manually_in_google_is_recreated(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 2)
    run()
    gid = next(iter(google.live_events(TARGET)))
    google.events[TARGET][gid]["status"] = "cancelled"
    result = run()
    assert result.updated + result.created == 1
    assert len(google.live_events(TARGET)) == 2


# -- recurrence ---------------------------------------------------------------------------

SERIES = vevent("s@test", "20261103T090000", "20261103T100000", "Serie", "RRULE:FREQ=WEEKLY;COUNT=10\nEXDATE;TZID=Europe/Berlin:20261110T090000")


def test_recurring_series_with_exception_and_override(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    override = vevent("s@test", "20261117T140000", "20261117T150000", "Verschoben", "RECURRENCE-ID;TZID=Europe/Berlin:20261117T090000")
    icloud.put_event(source, "s.ics", ics(SERIES, override))
    result = run()
    assert result.failed == 0
    masters = list(google.live_events(TARGET).values())
    assert len(masters) == 1
    rec = masters[0]["recurrence"]
    assert "RRULE:FREQ=WEEKLY;COUNT=10" in rec
    assert "EXDATE;TZID=Europe/Berlin:20261110T090000" in rec
    instance_id = f"{masters[0]['id']}_20261117T080000Z"
    assert google.instances[instance_id]["summary"] == "Verschoben"
    assert google.instances[instance_id]["start"]["dateTime"] == "2026-11-17T14:00:00+01:00"

    # unchanged rerun: nothing written
    writes = len(google.writes())
    run()
    assert len(google.writes()) == writes

    # override removed in iCloud -> occurrence reset to series values
    icloud.put_event(source, "s.ics", ics(SERIES))
    reset = run()
    assert any(i.action == "reset_instance" for i in reset.items)
    assert google.instances[instance_id]["summary"] == "Serie"
    assert google.instances[instance_id]["start"]["dateTime"] == "2026-11-17T09:00:00+01:00"


def test_cancelled_single_occurrence(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    cancelled = vevent("s@test", "20261124T090000", "20261124T100000", "Serie", "RECURRENCE-ID;TZID=Europe/Berlin:20261124T090000\nSTATUS:CANCELLED")
    icloud.put_event(source, "s.ics", ics(SERIES, cancelled))
    run()
    master_id = next(iter(google.live_events(TARGET)))
    assert google.instances[f"{master_id}_20261124T080000Z"]["status"] == "cancelled"


def test_deleting_series_removes_master_and_override_mappings(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    override = vevent("s@test", "20261117T140000", "20261117T150000", "Verschoben", "RECURRENCE-ID;TZID=Europe/Berlin:20261117T090000")
    icloud.put_event(source, "s.ics", ics(SERIES, override))
    run()
    assert mapping_count() == 8
    icloud.remove_event(source, "s.ics")
    result = run()
    assert result.deleted == 1
    assert mapping_count() == 6


# -- all-day / time zones -----------------------------------------------------------------


def test_all_day_and_timezone_change(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    icloud.put_event(source, "d.ics", ics(vevent("d@test", "20261224", "20261227", "Urlaub")))
    icloud.put_event(source, "t.ics", ics(vevent("t@test", "20261201T090000", "20261201T100000", "Call")))
    run()
    events = {e["summary"]: e for e in google.live_events(TARGET).values()}
    assert events["Urlaub"]["start"] == {"date": "2026-12-24"} and events["Urlaub"]["end"] == {"date": "2026-12-27"}

    icloud.put_event(source, "t.ics", ics(vevent("t@test", "20261201T090000", "20261201T100000", "Call", tz="America/New_York")))
    result = run()
    assert result.updated == 1
    events = {e["summary"]: e for e in google.live_events(TARGET).values()}
    assert events["Call"]["start"] == {"dateTime": "2026-12-01T09:00:00-05:00", "timeZone": "America/New_York"}


# -- failures -----------------------------------------------------------------------------


def test_partial_failure_keeps_going(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 3)
    from app.sync.ical import google_event_id, pair_key

    with session_scope() as db:
        s = db.get(AppSettings, 1)
        assert s is not None
        bad = google_event_id(pair_key(s.source_calendar_url or "", TARGET), "e1@test")
    google.fail_event_ids[bad] = 400
    result = run()
    assert result.status == "partial" and result.message_code == "sync.partial_failure"
    assert result.created == 2 and result.failed == 1
    del google.fail_event_ids[bad]
    again = run()
    assert again.created == 1 and again.status == "success"


def test_rate_limit_is_retried(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 2)
    google.rate_limit_next = 3
    result = run()
    assert result.status == "success" and result.created == 2


def test_expired_access_token_is_refreshed(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 1)
    google.force_401_once = True
    result = run()
    assert result.status == "success" and result.created == 1


def test_revoked_refresh_token_requires_reauth(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 1)
    google.access_token = "rotated-elsewhere"
    google.refresh_invalid = True
    result = run()
    assert result.status == "failed" and result.message_code == "google.reauth_required"
    with session_scope() as db:
        cred = db.get(Credential, "google")
        assert cred is not None and cred.status == "reauth_required"


def test_icloud_unreachable_fails_without_changes(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 6)
    run()
    icloud.fail_status = 503
    result = run()
    assert result.status == "failed" and result.message_code == "icloud.unreachable"
    assert len(google.live_events(TARGET)) == 6


def test_icloud_auth_failure_is_reported(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    from app.crypto import encrypt

    with session_scope() as db:
        cred = db.get(Credential, "icloud")
        assert cred is not None
        cred.secret_enc = encrypt("wrong-pass-word-xxxx", "icloud.app_password")
    result = run()
    assert result.status == "failed" and result.message_code == "icloud.auth_failed"


def test_missing_source_calendar_fails(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    del icloud.calendars[source.path]
    result = run()
    assert result.status == "failed" and result.message_code == "icloud.calendar_not_found"


def test_primary_target_requires_unlock(google: FakeGoogle) -> None:
    settings(target_calendar_id="me@example.com", target_is_primary=True)
    result = run()
    assert result.status == "failed" and result.message_code == "google.primary_locked"
    assert google.writes() == []


def test_parallel_runs_are_prevented(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 1)
    holder_ready, release = threading.Event(), threading.Event()

    def hold() -> None:
        with pair_lock(services.LOCK_NAME) as ok:
            assert ok
            holder_ready.set()
            release.wait(5)

    t = threading.Thread(target=hold)
    t.start()
    holder_ready.wait(5)
    try:
        assert services.sync_running()
        with pytest.raises(Exception) as exc:
            services.start_manual_run(False, False)
        assert getattr(exc.value, "code", "") == "sync.already_running"
        assert services.execute_run(RunOptions(trigger="schedule")) is None
        assert google.writes() == []
    finally:
        release.set()
        t.join()


def test_scheduled_run_skips_when_ctag_unchanged(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 2)
    run()
    calls = len(icloud.requests)
    assert services.execute_run(RunOptions(trigger="schedule")) is None
    report_calls = [r for r in icloud.requests[calls:] if r[0] == "REPORT"]
    assert report_calls == [], "unchanged ctag must skip the expensive fetch"


def test_token_refresh_in_the_middle_of_a_run(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    """A refresh needs a DB write while the run is active - must not dead-lock on SQLite."""
    add_events(icloud, source, 2)
    google.force_401_on_list_once = True
    result = run()
    assert result.status == "success" and result.created == 2


def test_detached_override_is_cleaned_up(icloud: FakeICloud, google: FakeGoogle, source: FakeCalendar) -> None:
    add_events(icloud, source, 1, prefix="keep")  # keeps the source non-empty (empty source never deletes)
    override = vevent("s@test", "20261117T140000", "20261117T150000", "Verschoben", "RECURRENCE-ID;TZID=Europe/Berlin:20261117T090000")
    icloud.put_event(source, "s.ics", ics(SERIES, override))
    from app.sync.ical import google_event_id, pair_key

    with session_scope() as db:
        s = db.get(AppSettings, 1)
        assert s is not None
        master_id = google_event_id(pair_key(s.source_calendar_url or "", TARGET), "s@test")
    google.no_instance_for.add(master_id)  # Google does not know that occurrence -> standalone copy
    run()
    live = google.live_events(TARGET)
    assert len(live) == 3 and any(e["summary"] == "Verschoben" for e in live.values())

    icloud.put_event(source, "s.ics", ics(SERIES))  # exception removed in iCloud
    run()
    live = google.live_events(TARGET)
    assert sorted(e["summary"] for e in live.values()) == ["Serie", "Termin 0"]

    icloud.put_event(source, "s.ics", ics(SERIES, override))
    run()
    icloud.remove_event(source, "s.ics")  # whole series deleted
    result = run()
    assert result.deleted == 2
    assert [e["summary"] for e in google.live_events(TARGET).values()] == ["Termin 0"]
    assert mapping_count() == 1
