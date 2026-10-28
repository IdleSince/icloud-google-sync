"""iCalendar (VEVENT) -> normalized components -> Google Calendar event payloads.

Attendees and organizers are intentionally never copied: Google would otherwise
send invitations. All writes additionally use ``sendUpdates=none``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, tzinfo
from functools import lru_cache
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

import icalendar

log = logging.getLogger(__name__)

MAX_REMINDERS = 5
MAX_REMINDER_MINUTES = 40320  # Google limit: 4 weeks


@dataclass(frozen=True)
class MapOptions:
    default_timezone: str = "Europe/Berlin"
    sync_reminders: bool = True
    sync_descriptions: bool = True
    pair_key: str = ""


@dataclass
class SourceComponent:
    uid: str
    recurrence_id: str  # "" for masters/single events
    kind: str  # single | master | override
    href: str
    etag: str | None
    cancelled: bool
    payload: dict[str, Any]
    title: str | None
    start_repr: str
    original_start: str | None = None  # RFC3339 / date of the replaced occurrence (overrides)
    content_hash: str = ""
    problems: list[str] = field(default_factory=list)


# --- ids ------------------------------------------------------------------------------


def pair_key(source_url: str, target_calendar_id: str) -> str:
    return hashlib.sha256(f"{source_url}|{target_calendar_id}".encode()).hexdigest()[:16]


_B32 = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", "0123456789abcdefghijklmnopqrstuv")


def google_event_id(pkey: str, uid: str, recurrence_id: str = "") -> str:
    """Deterministic Google event id (base32hex, allowed chars a-v0-9).

    Deterministic ids make inserts idempotent: re-inserting the same event yields
    HTTP 409 instead of a duplicate, even if the local database was lost.
    """
    digest = hashlib.sha256(f"{pkey}\x00{uid}\x00{recurrence_id}".encode()).digest()[:20]
    return base64.b32encode(digest).decode("ascii").translate(_B32).rstrip("=")


def uid_hash(uid: str) -> str:
    return hashlib.sha256(uid.encode()).hexdigest()[:32]


def content_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


# --- time helpers ---------------------------------------------------------------------


@lru_cache(maxsize=1)
def _iana_names() -> frozenset[str]:
    return frozenset(available_timezones())


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def iana_name(tz: tzinfo | None) -> str | None:
    key = getattr(tz, "key", None)
    if isinstance(key, str) and key in _iana_names():
        return key
    if tz is UTC or (tz is not None and tz.utcoffset(None) == timedelta(0) and getattr(tz, "key", "") in ("UTC", "Etc/UTC")):
        return "UTC"
    return None


def resolve_datetime(value: datetime, default_tz: str) -> tuple[datetime, str]:
    """Returns an aware datetime and the IANA zone name Google should use."""
    if value.tzinfo is None:  # floating time -> configured default zone
        zone = _zone(default_tz)
        return value.replace(tzinfo=zone), zone.key
    name = iana_name(value.tzinfo)
    if name:
        return value, name
    # Custom VTIMEZONE (non IANA). If it matches the default zone at this instant, use the
    # default zone so recurring events keep following DST; otherwise fall back to UTC.
    zone = _zone(default_tz)
    if value.utcoffset() == value.replace(tzinfo=zone).utcoffset():
        return value.replace(tzinfo=zone), zone.key
    return value.astimezone(UTC), "UTC"


def _iso(value: datetime) -> str:
    return value.isoformat()


def recurrence_key(value: date | datetime, default_tz: str) -> str:
    if isinstance(value, datetime):
        aware, _ = resolve_datetime(value, default_tz)
        return aware.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    return value.strftime("%Y%m%d")


def original_start_value(value: date | datetime, default_tz: str) -> str:
    if isinstance(value, datetime):
        aware, _ = resolve_datetime(value, default_tz)
        return aware.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return value.isoformat()


# --- mapping --------------------------------------------------------------------------


def _decoded(component: icalendar.cal.Component, name: str) -> Any:
    if name not in component:
        return None
    try:
        return component.decoded(name)
    except Exception:  # malformed property -> treat as missing
        return None


def _text(component: icalendar.cal.Component, name: str) -> str | None:
    value = component.get(name)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _time_payload(
    start: date | datetime, end: date | datetime | None, duration: timedelta | None, default_tz: str
) -> tuple[dict[str, Any], dict[str, Any], str | None]:
    if not isinstance(start, datetime):
        end_date: date
        if isinstance(end, date) and not isinstance(end, datetime) and end > start:
            end_date = end
        elif duration is not None and duration.days >= 1:
            end_date = start + timedelta(days=duration.days)
        else:
            end_date = start + timedelta(days=1)
        return {"date": start.isoformat()}, {"date": end_date.isoformat()}, None

    start_aware, tz_name = resolve_datetime(start, default_tz)
    if isinstance(end, datetime):
        end_aware, end_tz = resolve_datetime(end, default_tz)
    elif duration is not None:
        end_aware, end_tz = start_aware + duration, tz_name
    else:
        end_aware, end_tz = start_aware, tz_name
    if end_aware < start_aware:
        end_aware, end_tz = start_aware, tz_name
    return (
        {"dateTime": _iso(start_aware), "timeZone": tz_name},
        {"dateTime": _iso(end_aware), "timeZone": end_tz},
        tz_name,
    )


def _date_list_lines(component: icalendar.cal.Component, prop: str, all_day: bool, tz_name: str | None, default_tz: str) -> list[str]:
    raw = component.get(prop)
    if raw is None:
        return []
    groups = raw if isinstance(raw, list) else [raw]
    values: list[date | datetime] = []
    for group in groups:
        for item in getattr(group, "dts", []):
            if isinstance(item.dt, tuple):  # RDATE PERIOD - not representable in Google
                continue
            values.append(item.dt)
    if not values:
        return []
    if all_day:
        dates = sorted({(v.date() if isinstance(v, datetime) else v).strftime("%Y%m%d") for v in values})
        return [f"{prop};VALUE=DATE:{','.join(dates)}"]
    zone_name = tz_name or "UTC"
    zone = _zone(zone_name)
    stamps: set[str] = set()
    for v in values:
        if isinstance(v, datetime):
            aware, _ = resolve_datetime(v, default_tz)
        else:  # date value on a timed series: Apple sometimes does this - use midnight local
            aware = datetime(v.year, v.month, v.day, tzinfo=zone)
        if zone_name == "UTC":
            stamps.add(aware.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ"))
        else:
            stamps.add(aware.astimezone(zone).strftime("%Y%m%dT%H%M%S"))
    joined = ",".join(sorted(stamps))
    return [f"{prop}:{joined}"] if zone_name == "UTC" else [f"{prop};TZID={zone_name}:{joined}"]


def _reminders(component: icalendar.cal.Component, start: date | datetime, end: date | datetime | None) -> list[dict[str, Any]]:
    minutes: set[int] = set()
    for alarm in component.walk("VALARM"):
        action = str(alarm.get("ACTION", "DISPLAY")).upper()
        if action not in ("DISPLAY", "AUDIO", "EMAIL"):
            continue
        trigger = _decoded(alarm, "TRIGGER")
        if trigger is None:
            continue
        related = str(alarm["TRIGGER"].params.get("RELATED", "START")).upper()
        if isinstance(trigger, timedelta):
            if related == "END":
                continue  # relative to end cannot be expressed in Google
            value = -int(trigger.total_seconds() // 60)
        elif isinstance(trigger, datetime) and isinstance(start, datetime):
            start_aware = start if start.tzinfo else start.replace(tzinfo=UTC)
            trig = trigger if trigger.tzinfo else trigger.replace(tzinfo=UTC)
            value = int((start_aware - trig).total_seconds() // 60)
        else:
            continue
        if 0 <= value <= MAX_REMINDER_MINUTES:
            minutes.add(value)
    return [{"method": "popup", "minutes": m} for m in sorted(minutes)[:MAX_REMINDERS]]


def build_payload(component: icalendar.cal.Component, opts: MapOptions, *, uid: str, recurrence_id: str, with_recurrence: bool) -> tuple[dict[str, Any], str]:
    start = _decoded(component, "DTSTART")
    if start is None:
        raise ValueError("missing DTSTART")
    end = _decoded(component, "DTEND")
    duration = _decoded(component, "DURATION")
    if not isinstance(duration, timedelta):
        duration = None
    start_obj, end_obj, tz_name = _time_payload(start, end, duration, opts.default_timezone)

    payload: dict[str, Any] = {
        "summary": _text(component, "SUMMARY") or "",
        "start": start_obj,
        "end": end_obj,
        "status": "tentative" if str(component.get("STATUS", "")).upper() == "TENTATIVE" else "confirmed",
        "transparency": "transparent" if str(component.get("TRANSP", "")).upper() == "TRANSPARENT" else "opaque",
        "visibility": "private" if str(component.get("CLASS", "")).upper() in ("PRIVATE", "CONFIDENTIAL") else "default",
        "guestsCanInviteOthers": False,
        "extendedProperties": {
            "private": {
                "icgs_managed": "1",
                "icgs_pair": opts.pair_key,
                "icgs_uid": uid_hash(uid),
                "icgs_rid": recurrence_id,
            }
        },
    }
    location = _text(component, "LOCATION")
    payload["location"] = location or ""
    payload["description"] = (_text(component, "DESCRIPTION") or "") if opts.sync_descriptions else ""
    reminders = _reminders(component, start, end) if opts.sync_reminders else []
    payload["reminders"] = {"useDefault": False, "overrides": reminders}

    if with_recurrence:
        all_day = not isinstance(start, datetime)
        lines: list[str] = []
        rrules = component.get("RRULE")
        for rule in rrules if isinstance(rrules, list) else ([rrules] if rrules is not None else []):
            lines.append("RRULE:" + rule.to_ical().decode())
        lines += _date_list_lines(component, "EXDATE", all_day, tz_name, opts.default_timezone)
        lines += _date_list_lines(component, "RDATE", all_day, tz_name, opts.default_timezone)
        payload["recurrence"] = lines

    start_repr = start_obj.get("date") or datetime.fromisoformat(start_obj["dateTime"]).astimezone(UTC).isoformat().replace("+00:00", "Z")
    return payload, start_repr


def parse_resource(data: str, href: str, etag: str | None, opts: MapOptions) -> list[SourceComponent]:
    """Parses one CalDAV resource (one UID: master + its overrides, or a single event)."""
    try:
        calendar = icalendar.Calendar.from_ical(data)
    except Exception as exc:
        raise ValueError("unparsable calendar resource") from exc

    events = list(calendar.walk("VEVENT"))
    masters = {str(e.get("UID")) for e in events if e.get("RECURRENCE-ID") is None and (e.get("RRULE") is not None or e.get("RDATE") is not None)}
    result: list[SourceComponent] = []
    for event in events:
        uid_value = event.get("UID")
        if uid_value is None:
            continue
        uid = str(uid_value)
        rid_raw = _decoded(event, "RECURRENCE-ID")
        is_recurring = event.get("RRULE") is not None or event.get("RDATE") is not None
        if rid_raw is not None and uid in masters:
            kind = "override"
            rid = recurrence_key(rid_raw, opts.default_timezone)
        elif rid_raw is not None:
            kind = "single"  # an instance without its master (e.g. invited to one occurrence)
            rid = recurrence_key(rid_raw, opts.default_timezone)
        else:
            kind = "master" if is_recurring else "single"
            rid = ""
        try:
            payload, start_repr = build_payload(event, opts, uid=uid, recurrence_id=rid, with_recurrence=kind == "master")
        except ValueError:
            log.warning("skipping component without usable DTSTART", extra={"fields": {"uid": uid_hash(uid)[:12]}})
            continue
        cancelled = str(event.get("STATUS", "")).upper() == "CANCELLED"
        comp = SourceComponent(
            uid=uid,
            recurrence_id=rid,
            kind=kind,
            href=href,
            etag=etag,
            cancelled=cancelled,
            payload=payload,
            title=(payload["summary"] or None),
            start_repr=start_repr,
            original_start=original_start_value(rid_raw, opts.default_timezone) if rid_raw is not None else None,
        )
        comp.content_hash = content_hash({"p": payload, "c": cancelled})
        result.append(comp)
    return result
