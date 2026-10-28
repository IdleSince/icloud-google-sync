"""Calendar discovery and the "is the privately shared calendar reachable?" diagnosis."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlparse

from ..crypto import sha256_hex
from ..errors import AppError, ICloudAuthError, ICloudError, ICloudUnreachable
from .client import NS, CalDAVClient, DavResponse, q

WRITE_PRIVS = {"write", "write-content", "all", "bind", "write-properties"}


def calendar_id(url: str) -> str:
    """Stable identifier independent of list order: hash of the normalized collection path."""
    path = urlparse(url).path.rstrip("/") + "/"
    return "c_" + sha256_hex(path)[:16]


@dataclass
class DiscoveredCalendar:
    id: str
    url: str
    name: str
    color: str | None
    description: str | None
    ownership: str  # own | shared | unknown
    owner: str | None
    access: str  # read | read_write | unknown
    privileges: list[str]
    supports_events: bool
    readable: bool
    event_count: int | None
    ctag: str | None
    error: dict[str, Any] | None = None
    selected: bool = False
    raw: dict[str, Any] = field(default_factory=dict)

    def public(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("raw")
        data.pop("ctag")
        return data


def _text(el: ET.Element | None) -> str | None:
    if el is None:
        return None
    value = "".join(el.itertext()).strip()
    return value or None


def _local(tag: str) -> str:
    return tag.split("}", 1)[-1]


def _resource_types(resp: DavResponse) -> list[str]:
    el = resp.props.get(q("D", "resourcetype"))
    return [_local(child.tag) for child in el] if el is not None else []


def _privileges(resp: DavResponse) -> list[str]:
    el = resp.props.get(q("D", "current-user-privilege-set"))
    if el is None:
        return []
    names: list[str] = []
    for priv in el.findall("D:privilege", NS):
        for child in priv:
            names.append(_local(child.tag))
    return sorted(set(names))


def _components(resp: DavResponse) -> list[str]:
    el = resp.props.get(q("C", "supported-calendar-component-set"))
    if el is None:
        return []
    return [comp.get("name", "").upper() for comp in el.findall("C:comp", NS)]


def _invite_organizer(resp: DavResponse) -> str | None:
    invite = resp.props.get(q("CS", "invite"))
    if invite is None:
        return None
    organizer = invite.find("CS:organizer", NS)
    if organizer is None:
        return None
    common = _text(organizer.find("CS:common-name", NS))
    if common:
        return common
    first = _text(organizer.find("CS:first-name", NS)) or ""
    last = _text(organizer.find("CS:last-name", NS)) or ""
    full = f"{first} {last}".strip()
    if full:
        return full
    href = _text(organizer.find("D:href", NS))
    return href.removeprefix("mailto:") if href else None


def _sanitized_raw(resp: DavResponse) -> dict[str, Any]:
    props: dict[str, Any] = {}
    for tag, el in resp.props.items():
        name = _local(tag)
        if name in ("invite",):
            # keep structure but not every invitee address
            props[name] = {
                "organizer": _invite_organizer(resp),
                "user_count": len(el.findall("CS:user", NS)),
            }
        elif len(el):
            props[name] = [_local(c.tag) for c in el] if name != "owner" else _text(el)
        else:
            props[name] = _text(el)
    return {"url": resp.href, "resourcetype": _resource_types(resp), "properties": props, "missing": sorted(_local(m) for m in resp.missing)}


def build_calendar(client: CalDAVClient, resp: DavResponse, principal_url: str, *, count: bool = True) -> DiscoveredCalendar:
    types = _resource_types(resp)
    privileges = _privileges(resp)
    components = _components(resp)
    supports_events = not components or "VEVENT" in components

    owner_el = resp.props.get(q("D", "owner"))
    owner_href = _text(owner_el.find("D:href", NS)) if owner_el is not None else None
    principal_path = urlparse(principal_url).path.rstrip("/")
    organizer = _invite_organizer(resp)

    is_shared_marker = "shared" in types or q("CS", "shared-url") in resp.props
    if "shared-owner" in types:
        ownership = "own"  # I own it and shared it with others
    elif is_shared_marker or owner_href and urlparse(owner_href).path.rstrip("/") != principal_path:
        ownership = "shared"
    elif owner_href:
        ownership = "own"
    else:
        ownership = "own" if not organizer else "shared"

    owner: str | None = None
    if ownership == "shared":
        owner = organizer
        if not owner and owner_href:
            owner = client.principal_display_name(client.absolute(resp.href, owner_href))

    if privileges:
        access = "read_write" if WRITE_PRIVS.intersection(privileges) else ("read" if "read" in privileges else "unknown")
    else:
        access = "unknown"

    color_raw = _text(resp.props.get(q("ICAL", "calendar-color")))
    color = color_raw[:7] if color_raw and color_raw.startswith("#") else None

    cal = DiscoveredCalendar(
        id=calendar_id(resp.href),
        url=resp.href,
        name=_text(resp.props.get(q("D", "displayname"))) or urlparse(resp.href).path.rstrip("/").rsplit("/", 1)[-1],
        color=color,
        description=_text(resp.props.get(q("C", "calendar-description"))),
        ownership=ownership,
        owner=owner,
        access=access,
        privileges=privileges,
        supports_events=supports_events,
        readable=False,
        event_count=None,
        ctag=_text(resp.props.get(q("CS", "getctag"))) or _text(resp.props.get(q("D", "sync-token"))),
        raw=_sanitized_raw(resp),
    )
    if privileges and "read" not in privileges and "all" not in privileges:
        cal.error = {"code": "icloud.calendar_not_readable", "params": {}}
        return cal
    if not supports_events:
        cal.error = {"code": "icloud.calendar_no_events", "params": {}}
        cal.readable = True
        return cal
    if count:
        try:
            cal.event_count = client.count_events(resp.href)
            cal.readable = True
        except ICloudAuthError:
            raise
        except AppError as exc:
            cal.error = exc.to_dict()
    return cal


@dataclass
class DiscoveryResult:
    principal_url: str
    home_url: str
    calendars: list[DiscoveredCalendar]
    delegation_read_for: int
    delegation_write_for: int


def discover(client: CalDAVClient, *, count: bool = True) -> DiscoveryResult:
    principal = client.current_user_principal()
    info = client.principal_info(principal)
    home = client.calendar_home(principal, info)
    calendars: list[DiscoveredCalendar] = []
    for resp in client.list_collections(home):
        types = _resource_types(resp)
        if "calendar" not in types:
            continue  # home itself, inbox/outbox, notification collections
        calendars.append(build_calendar(client, resp, principal, count=count))
    calendars.sort(key=lambda c: (c.ownership != "shared", c.name.casefold()))

    def _count(tag: str) -> int:
        el = info.props.get(q("CS", tag)) if info else None
        return len(el.findall("D:href", NS)) if el is not None else 0

    return DiscoveryResult(principal, home, calendars, _count("calendar-proxy-read-for"), _count("calendar-proxy-write-for"))


def diagnose(client: CalDAVClient | None) -> dict[str, Any]:
    """Step-by-step diagnosis whether privately shared calendars are reachable via CalDAV."""
    steps: list[dict[str, Any]] = []
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")

    def step(key: str, status: str, **params: Any) -> None:
        steps.append({"key": key, "status": status, "params": params})

    def finish(conclusion: str, calendars: list[DiscoveredCalendar] | None = None) -> dict[str, Any]:
        done = {s["key"] for s in steps}
        for key in ("credentials", "principal", "calendar_home", "calendars", "shared_readable", "delegation"):
            if key not in done:
                step(key, "skipped")
        order = ["credentials", "principal", "calendar_home", "calendars", "shared_readable", "delegation"]
        steps.sort(key=lambda s: order.index(s["key"]))
        cals = calendars or []
        return {
            "checked_at": now,
            "steps": steps,
            "conclusion": conclusion,
            "calendars": [c.public() for c in cals],
            "raw": [c.raw for c in cals],
        }

    if client is None:
        step("credentials", "fail")
        return finish("not_configured")
    step("credentials", "ok")
    try:
        principal = client.current_user_principal()
        step("principal", "ok")
        info = client.principal_info(principal)
        home = client.calendar_home(principal, info)
        step("calendar_home", "ok")
        calendars = [build_calendar(client, r, principal) for r in client.list_collections(home) if "calendar" in _resource_types(r)]
    except ICloudAuthError:
        step("principal", "fail", error="icloud.auth_failed")
        return finish("auth_failed")
    except ICloudUnreachable:
        step("principal", "fail", error="icloud.unreachable")
        return finish("unreachable")
    except ICloudError as exc:
        failed = "calendar_home" if any(s["key"] == "principal" for s in steps) else "principal"
        step(failed, "fail", error=exc.code)
        return finish("unreachable")

    shared = [c for c in calendars if c.ownership == "shared"]
    own = [c for c in calendars if c.ownership == "own"]
    step("calendars", "ok" if calendars else "warn", total=len(calendars), own=len(own), shared=len(shared))
    readable_shared = [c for c in shared if c.readable and c.supports_events]
    if not shared:
        step("shared_readable", "warn", readable=0, shared=0)
        conclusion = "shared_not_listed"
    elif readable_shared:
        step("shared_readable", "ok" if len(readable_shared) == len(shared) else "warn", readable=len(readable_shared), shared=len(shared))
        conclusion = "shared_accessible"
    else:
        step("shared_readable", "fail", readable=0, shared=len(shared))
        conclusion = "shared_not_readable"

    def _count(tag: str) -> int:
        el = info.props.get(q("CS", tag)) if info else None
        return len(el.findall("D:href", NS)) if el is not None else 0

    step("delegation", "ok", read_for=_count("calendar-proxy-read-for"), write_for=_count("calendar-proxy-write-for"))
    calendars.sort(key=lambda c: (c.ownership != "shared", c.name.casefold()))
    return finish(conclusion, calendars)
