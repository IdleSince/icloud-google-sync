from __future__ import annotations

import re

from app.sync.ical import MapOptions, google_event_id, pair_key, parse_resource

from .fakes import ics, vevent

OPTS = MapOptions(default_timezone="Europe/Berlin", pair_key="pk")


def one(data: str, opts: MapOptions = OPTS):  # type: ignore[no-untyped-def]
    comps = parse_resource(data, "/c/x.ics", '"1"', opts)
    assert len(comps) == 1
    return comps[0]


def test_dst_offsets_follow_the_zone() -> None:
    summer = one(ics(vevent("a", "20260720T090000", "20260720T100000")))
    winter = one(ics(vevent("b", "20261026T090000", "20261026T100000")))  # day after the switch
    assert summer.payload["start"] == {"dateTime": "2026-07-20T09:00:00+02:00", "timeZone": "Europe/Berlin"}
    assert winter.payload["start"] == {"dateTime": "2026-10-26T09:00:00+01:00", "timeZone": "Europe/Berlin"}


def test_event_spanning_dst_switch_keeps_wall_clock_duration() -> None:
    comp = one(ics(vevent("c", "20261025T010000", "20261025T040000")))  # 3 h wall clock, 4 h real
    assert comp.payload["start"]["dateTime"] == "2026-10-25T01:00:00+02:00"
    assert comp.payload["end"]["dateTime"] == "2026-10-25T04:00:00+01:00"


def test_recurring_series_keeps_zone_for_dst() -> None:
    comp = one(ics(vevent("s", "20261019T090000", "20261019T100000", extra="RRULE:FREQ=WEEKLY;COUNT=4")))
    assert comp.kind == "master"
    assert comp.payload["start"]["timeZone"] == "Europe/Berlin"
    assert comp.payload["recurrence"] == ["RRULE:FREQ=WEEKLY;COUNT=4"]


def test_floating_time_uses_default_zone() -> None:
    comp = one(ics(vevent("f", "20261201T090000", "20261201T100000", tz=None)), MapOptions(default_timezone="Asia/Tokyo"))
    assert comp.payload["start"] == {"dateTime": "2026-12-01T09:00:00+09:00", "timeZone": "Asia/Tokyo"}


def test_utc_time() -> None:
    comp = one(ics(vevent("u", "20261201T090000Z", "20261201T100000Z")))
    assert comp.payload["start"]["dateTime"] == "2026-12-01T09:00:00+00:00"
    assert comp.payload["start"]["timeZone"] == "UTC"


def test_all_day_single_and_multi_day() -> None:
    single = one(ics(vevent("d1", "20261224")))
    multi = one(ics(vevent("d2", "20261224", "20261227")))
    assert single.payload["start"] == {"date": "2026-12-24"} and single.payload["end"] == {"date": "2026-12-25"}
    assert multi.payload["end"] == {"date": "2026-12-27"}
    assert single.start_repr == "2026-12-24"


def test_all_day_series_exdates_are_dates() -> None:
    comp = one(ics(vevent("d3", "20261201", "20261202", extra="RRULE:FREQ=DAILY;COUNT=5\nEXDATE;VALUE=DATE:20261203")))
    assert "EXDATE;VALUE=DATE:20261203" in comp.payload["recurrence"]


def test_exdate_in_other_zone_is_converted_to_series_zone() -> None:
    comp = one(ics(vevent("x", "20261103T090000", "20261103T100000", extra="RRULE:FREQ=WEEKLY;COUNT=4\nEXDATE:20261110T080000Z")))
    assert "EXDATE;TZID=Europe/Berlin:20261110T090000" in comp.payload["recurrence"]


def test_override_gets_recurrence_key_in_utc() -> None:
    master = vevent("o", "20261103T090000", "20261103T100000", extra="RRULE:FREQ=WEEKLY;COUNT=4")
    moved = vevent("o", "20261110T120000", "20261110T130000", "Moved", "RECURRENCE-ID;TZID=Europe/Berlin:20261110T090000")
    comps = parse_resource(ics(master, moved), "/c/o.ics", None, OPTS)
    override = next(c for c in comps if c.kind == "override")
    assert override.recurrence_id == "20261110T080000Z"
    assert override.original_start == "2026-11-10T08:00:00Z"
    assert "recurrence" not in override.payload


def test_orphan_instance_without_master_is_single_event() -> None:
    lonely = vevent("l", "20261110T120000", "20261110T130000", "Only me", "RECURRENCE-ID;TZID=Europe/Berlin:20261110T090000")
    comp = one(ics(lonely))
    assert comp.kind == "single" and comp.recurrence_id == "20261110T080000Z"


def test_reminders_availability_visibility_status() -> None:
    extra = "\n".join(
        [
            "TRANSP:TRANSPARENT",
            "CLASS:PRIVATE",
            "STATUS:TENTATIVE",
            "LOCATION:Praxis",
            "DESCRIPTION:Bitte Karte mitbringen",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "TRIGGER:-PT15M",
            "END:VALARM",
            "BEGIN:VALARM",
            "ACTION:AUDIO",
            "TRIGGER:-P1D",
            "END:VALARM",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "TRIGGER;RELATED=END:PT0M",
            "END:VALARM",
        ]
    )
    p = one(ics(vevent("r", "20261201T090000", "20261201T100000", "Zahnarzt", extra))).payload
    assert p["transparency"] == "transparent"
    assert p["visibility"] == "private"
    assert p["status"] == "tentative"
    assert p["location"] == "Praxis" and p["description"] == "Bitte Karte mitbringen"
    assert p["reminders"] == {"useDefault": False, "overrides": [{"method": "popup", "minutes": 15}, {"method": "popup", "minutes": 1440}]}


def test_options_disable_reminders_and_descriptions() -> None:
    extra = "DESCRIPTION:geheim\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT15M\nEND:VALARM"
    opts = MapOptions(sync_reminders=False, sync_descriptions=False)
    p = one(ics(vevent("r", "20261201T090000", "20261201T100000", "x", extra)), opts).payload
    assert p["description"] == ""
    assert p["reminders"] == {"useDefault": False, "overrides": []}


def test_no_attendees_in_payload() -> None:
    extra = "ORGANIZER:mailto:a@example.org\nATTENDEE:mailto:b@example.org"
    p = one(ics(vevent("a", "20261201T090000", "20261201T100000", "x", extra))).payload
    assert "attendees" not in p and "organizer" not in p
    assert p["guestsCanInviteOthers"] is False


def test_timezone_change_changes_hash() -> None:
    a = one(ics(vevent("z", "20261201T090000", "20261201T100000")))
    b = one(ics(vevent("z", "20261201T090000", "20261201T100000", tz="Europe/London")))
    assert a.content_hash != b.content_hash


def test_custom_vtimezone_matching_default_maps_to_iana() -> None:
    data = "\r\n".join(
        [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:x",
            "BEGIN:VTIMEZONE",
            "TZID:Mitteleuropa",
            "BEGIN:STANDARD",
            "DTSTART:19701025T030000",
            "TZOFFSETFROM:+0200",
            "TZOFFSETTO:+0100",
            "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
            "END:STANDARD",
            "BEGIN:DAYLIGHT",
            "DTSTART:19700329T020000",
            "TZOFFSETFROM:+0100",
            "TZOFFSETTO:+0200",
            "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
            "END:DAYLIGHT",
            "END:VTIMEZONE",
            "BEGIN:VEVENT",
            "UID:ct",
            "DTSTAMP:20260101T000000Z",
            "DTSTART;TZID=Mitteleuropa:20261201T090000",
            "DTEND;TZID=Mitteleuropa:20261201T100000",
            "SUMMARY:x",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
    )
    p = one(data).payload
    assert p["start"]["dateTime"] == "2026-12-01T09:00:00+01:00"
    assert p["start"]["timeZone"] == "Europe/Berlin"


def test_deterministic_google_ids() -> None:
    pk = pair_key("https://x/cal/", "target")
    a, b = google_event_id(pk, "uid-1"), google_event_id(pk, "uid-1")
    assert a == b and a != google_event_id(pk, "uid-2") and a != google_event_id(pk, "uid-1", "20261110T080000Z")
    assert re.fullmatch(r"[0-9a-v]{5,1024}", a), "Google allows base32hex characters only"
