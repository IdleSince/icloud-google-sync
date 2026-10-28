"""Minimal, strict CalDAV client for iCloud.

Why not the ``caldav`` package: we need the Apple/CalendarServer sharing
properties (``CS:shared-url``, ``CS:invite``, ``CS:organizer``) verbatim for the
diagnosis, full control over redirects (credentials must only ever be sent to
``*.icloud.com`` over https) and a hard "was the listing complete?" signal that
gates deletions in the sync engine.
"""

from __future__ import annotations

import threading
import xml.etree.ElementTree as ET
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urljoin, urlparse

import httpx
from defusedxml import DefusedXmlException
from defusedxml.ElementTree import fromstring as safe_fromstring

from ..errors import ICloudAuthError, ICloudUnexpected, ICloudUnreachable
from ..http_retry import send_with_retry

NS = {
    "D": "DAV:",
    "C": "urn:ietf:params:xml:ns:caldav",
    "CS": "http://calendarserver.org/ns/",
    "ICAL": "http://apple.com/ns/ical/",
}

for _prefix, _uri in NS.items():
    ET.register_namespace(_prefix.lower() if _prefix != "D" else "d", _uri)


def q(prefix: str, name: str) -> str:
    return f"{{{NS[prefix]}}}{name}"


MULTIGET_BATCH = 50


@dataclass
class DavResponse:
    href: str
    status: int  # status of the response itself or of the 200 propstat
    props: dict[str, ET.Element] = field(default_factory=dict)
    missing: set[str] = field(default_factory=set)  # props reported with non-200 status


@dataclass
class EventResource:
    href: str
    etag: str | None
    data: str


@dataclass
class FetchResult:
    resources: list[EventResource]
    complete: bool
    problems: list[str]


def _status_code(text: str | None) -> int:
    # "HTTP/1.1 200 OK"
    if not text:
        return 0
    parts = text.split()
    try:
        return int(parts[1])
    except (IndexError, ValueError):
        return 0


def parse_multistatus(body: bytes) -> list[DavResponse]:
    try:
        # defusedxml refuses DTDs/entities (XXE, billion laughs) - the server is remote input.
        root = safe_fromstring(body, forbid_dtd=True)
    except (ET.ParseError, DefusedXmlException) as exc:
        raise ICloudUnexpected({"reason": "xml"}) from exc
    if root.tag != q("D", "multistatus"):
        raise ICloudUnexpected({"reason": "not_multistatus"})
    results: list[DavResponse] = []
    for resp in root.findall("D:response", NS):
        href_el = resp.find("D:href", NS)
        if href_el is None or not (href_el.text or "").strip():
            continue
        href = (href_el.text or "").strip()
        own_status = resp.find("D:status", NS)
        item = DavResponse(href=href, status=_status_code(own_status.text) if own_status is not None else 0)
        for propstat in resp.findall("D:propstat", NS):
            code = _status_code(propstat.findtext("D:status", default="", namespaces=NS))
            prop = propstat.find("D:prop", NS)
            if prop is None:
                continue
            for child in prop:
                if code == 200:
                    item.props[child.tag] = child
                    item.status = 200
                else:
                    item.missing.add(child.tag)
        results.append(item)
    return results


def _prop_xml(props: Iterable[str]) -> str:
    inner = "".join(f"<{p}/>" for p in props)
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        f'<d:propfind xmlns:d="DAV:" xmlns:c="{NS["C"]}" xmlns:cs="{NS["CS"]}" xmlns:ical="{NS["ICAL"]}">'
        f"<d:prop>{inner}</d:prop></d:propfind>"
    )


def _fmt_utc(value: datetime) -> str:
    return value.strftime("%Y%m%dT%H%M%SZ")


class CalDAVClient:
    def __init__(
        self,
        username: str,
        password: str,
        *,
        base_url: str = "https://caldav.icloud.com/",
        allowed_host_suffix: str = ".icloud.com",
        transport: httpx.BaseTransport | None = None,
        timeout: float = 30.0,
        cancel: threading.Event | None = None,
    ) -> None:
        self.base_url = base_url
        self.allowed_host_suffix = allowed_host_suffix
        self.cancel = cancel
        self._client = httpx.Client(
            auth=httpx.BasicAuth(username, password),
            timeout=httpx.Timeout(timeout, connect=10.0),
            follow_redirects=False,
            transport=transport,
            headers={"User-Agent": "icloud-google-calendar-sync/1.0"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> CalDAVClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- transport -----------------------------------------------------------------

    def _check_host(self, url: str) -> None:
        parsed = urlparse(url)
        host = parsed.hostname or ""
        base_host = urlparse(self.base_url).hostname or ""
        if parsed.scheme != "https" and host != base_host:
            raise ICloudUnexpected({"reason": "insecure_redirect"})
        if host != base_host and not host.endswith(self.allowed_host_suffix):
            raise ICloudUnexpected({"reason": "foreign_redirect"})

    def request(self, method: str, url: str, *, body: str | None = None, depth: str | None = None) -> httpx.Response:
        headers = {"Content-Type": "application/xml; charset=utf-8"} if body else {}
        if depth is not None:
            headers["Depth"] = depth
        current = url
        for _ in range(6):
            self._check_host(current)

            def send(target: str = current) -> httpx.Response:
                return self._client.request(method, target, content=body.encode("utf-8") if body else None, headers=headers)

            try:
                response = send_with_retry(send, attempts=4, cancel=self.cancel)
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                raise ICloudUnreachable({"reason": type(exc).__name__}) from exc
            if response.status_code in (301, 302, 307, 308) and "location" in response.headers:
                current = urljoin(current, response.headers["location"])
                continue
            if response.status_code == 401:
                raise ICloudAuthError()
            if response.status_code >= 500 or response.status_code == 429:
                raise ICloudUnreachable({"status": response.status_code})
            return response
        raise ICloudUnexpected({"reason": "redirect_loop"})

    def propfind(self, url: str, props: Iterable[str], depth: str = "0") -> list[DavResponse]:
        response = self.request("PROPFIND", url, body=_prop_xml(props), depth=depth)
        if response.status_code == 404:
            return []
        if response.status_code != 207:
            raise ICloudUnexpected({"status": response.status_code, "op": "propfind"})
        return parse_multistatus(response.content)

    def absolute(self, base: str, href: str) -> str:
        return urljoin(base, href)

    # -- discovery -----------------------------------------------------------------

    def current_user_principal(self) -> str:
        for url in (self.base_url, urljoin(self.base_url, "/.well-known/caldav")):
            for resp in self.propfind(url, ["d:current-user-principal"]):
                el = resp.props.get(q("D", "current-user-principal"))
                href = el.findtext("D:href", namespaces=NS) if el is not None else None
                if href:
                    return self.absolute(url, href.strip())
        raise ICloudUnexpected({"reason": "no_principal"})

    def principal_info(self, principal_url: str) -> DavResponse | None:
        props = [
            "c:calendar-home-set",
            "d:displayname",
            "cs:calendar-proxy-read-for",
            "cs:calendar-proxy-write-for",
            "c:calendar-user-address-set",
        ]
        responses = self.propfind(principal_url, props)
        return responses[0] if responses else None

    def calendar_home(self, principal_url: str, info: DavResponse | None = None) -> str:
        info = info or self.principal_info(principal_url)
        el = info.props.get(q("C", "calendar-home-set")) if info else None
        href = el.findtext("D:href", namespaces=NS) if el is not None else None
        if not href:
            raise ICloudUnexpected({"reason": "no_calendar_home"})
        return self.absolute(principal_url, href.strip())

    CALENDAR_PROPS = (
        "d:resourcetype",
        "d:displayname",
        "d:owner",
        "d:current-user-privilege-set",
        "d:sync-token",
        "cs:getctag",
        "cs:shared-url",
        "cs:invite",
        "cs:source",
        "c:supported-calendar-component-set",
        "c:calendar-description",
        "ical:calendar-color",
    )

    def list_collections(self, home_url: str) -> list[DavResponse]:
        responses = self.propfind(home_url, self.CALENDAR_PROPS, depth="1")
        for resp in responses:
            resp.href = self.absolute(home_url, resp.href)
        return responses

    def collection_props(self, url: str) -> DavResponse | None:
        responses = self.propfind(url, self.CALENDAR_PROPS, depth="0")
        return responses[0] if responses else None

    def principal_display_name(self, url: str) -> str | None:
        try:
            responses = self.propfind(url, ["d:displayname", "c:calendar-user-address-set"])
        except (ICloudUnexpected, ICloudUnreachable):
            return None
        if not responses:
            return None
        name = responses[0].props.get(q("D", "displayname"))
        if name is None:
            return None
        return (name.text or "").strip() or None

    # -- events --------------------------------------------------------------------

    def _query_hrefs(self, calendar_url: str, start: datetime | None, end: datetime | None) -> tuple[dict[str, str | None], list[str]]:
        time_range = f'<c:time-range start="{_fmt_utc(start)}" end="{_fmt_utc(end)}"/>' if start and end else ""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            f'<c:calendar-query xmlns:d="DAV:" xmlns:c="{NS["C"]}">'
            "<d:prop><d:getetag/></d:prop>"
            '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">'
            f"{time_range}"
            "</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"
        )
        response = self.request("REPORT", calendar_url, body=body, depth="1")
        if response.status_code == 403:
            raise ICloudUnexpected({"status": 403, "op": "calendar-query"})
        if response.status_code != 207:
            raise ICloudUnexpected({"status": response.status_code, "op": "calendar-query"})
        hrefs: dict[str, str | None] = {}
        problems: list[str] = []
        base_path = urlparse(calendar_url).path.rstrip("/")
        for resp in parse_multistatus(response.content):
            absolute = self.absolute(calendar_url, resp.href)
            if urlparse(absolute).path.rstrip("/") == base_path:
                continue  # the collection itself
            if resp.status == 507:
                problems.append("truncated")
                continue
            if resp.status != 200:
                problems.append(f"status_{resp.status}")
                continue
            etag_el = resp.props.get(q("D", "getetag"))
            hrefs[absolute] = (etag_el.text or "").strip() if etag_el is not None else None
        return hrefs, problems

    def count_events(self, calendar_url: str) -> int:
        hrefs, _ = self._query_hrefs(calendar_url, None, None)
        return len(hrefs)

    def fetch_events(self, calendar_url: str, start: datetime, end: datetime) -> FetchResult:
        """Two-step fetch (query hrefs, then multiget data) with completeness tracking."""
        hrefs, problems = self._query_hrefs(calendar_url, start, end)
        resources: list[EventResource] = []
        ordered = sorted(hrefs)
        for i in range(0, len(ordered), MULTIGET_BATCH):
            if self.cancel is not None and self.cancel.is_set():
                problems.append("cancelled")
                break
            batch = ordered[i : i + MULTIGET_BATCH]
            href_xml = "".join(f"<d:href>{_xml_escape(urlparse(h).path)}</d:href>" for h in batch)
            body = (
                '<?xml version="1.0" encoding="utf-8"?>'
                f'<c:calendar-multiget xmlns:d="DAV:" xmlns:c="{NS["C"]}">'
                f"<d:prop><d:getetag/><c:calendar-data/></d:prop>{href_xml}</c:calendar-multiget>"
            )
            response = self.request("REPORT", calendar_url, body=body, depth="1")
            if response.status_code != 207:
                raise ICloudUnexpected({"status": response.status_code, "op": "calendar-multiget"})
            got: dict[str, EventResource] = {}
            for resp in parse_multistatus(response.content):
                absolute = self.absolute(calendar_url, resp.href)
                data_el = resp.props.get(q("C", "calendar-data"))
                if resp.status == 200 and data_el is not None and (data_el.text or "").strip():
                    etag_el = resp.props.get(q("D", "getetag"))
                    got[absolute] = EventResource(absolute, (etag_el.text or "").strip() if etag_el is not None else None, data_el.text or "")
            for href in batch:
                if href in got:
                    resources.append(got[href])
                else:
                    problems.append("missing_data")
        return FetchResult(resources=resources, complete=not problems, problems=problems)

    def get_resource(self, href: str) -> tuple[int, str | None]:
        """Used to verify deletions: 404 means the event really is gone."""
        response = self.request("GET", href)
        if response.status_code == 200:
            return 200, response.text
        return response.status_code, None


def _xml_escape(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
