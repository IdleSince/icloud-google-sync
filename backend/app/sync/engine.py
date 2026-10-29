"""One-way sync engine: iCloud (CalDAV) -> Google Calendar.

Invariants:
* The source is only ever read (PROPFIND / REPORT / GET).
* Google events get deterministic ids -> no duplicates, even after DB loss.
* Deletions require: complete source fetch, verified source calendar, a
  per-event CalDAV GET returning 404 (or an explicit STATUS:CANCELLED), a
  Google event that carries our private pair marker, and the mass-deletion
  guard not being tripped. Dry-run modes never write to Google.
"""

from __future__ import annotations

import calendar as _calendar
import hashlib
import json
import logging
import threading
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..caldav.client import CalDAVClient, q
from ..caldav.discovery import calendar_id as source_calendar_id
from ..errors import AppError, GoogleReauthRequired, ICloudAuthError
from ..google.calendar import GoogleCalendarClient
from ..logging_setup import short_hash
from ..models import AppSettings, EventMapping, SyncPair, SyncRun, SyncRunItem, utcnow
from .ical import MapOptions, SourceComponent, google_event_id, pair_key, parse_resource

log = logging.getLogger(__name__)

FULL_SYNC_EVERY = timedelta(hours=6)
MAX_ITEMS_PER_RUN = 500
PERCENT_GUARD_MIN = 5  # the percentage guard only applies from this many planned deletions on


def add_months(value: datetime, months: int) -> datetime:
    month_index = value.month - 1 + months
    year = value.year + month_index // 12
    month = month_index % 12 + 1
    day = min(value.day, _calendar.monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def config_hash(s: AppSettings, pair: SyncPair) -> str:
    data = [s.past_months, s.future_months, s.default_timezone, s.sync_reminders, s.sync_descriptions, pair.source_calendar_url, pair.target_calendar_id]
    return hashlib.sha256(json.dumps(data).encode()).hexdigest()


@dataclass
class RunOptions:
    trigger: str = "schedule"
    dry_run: bool = False
    allow_mass_deletion: bool = False
    force_full: bool = False


@dataclass
class _Counters:
    created: int = 0
    updated: int = 0
    deleted: int = 0
    unchanged: int = 0
    failed: int = 0


@dataclass
class _State:
    counters: _Counters = field(default_factory=_Counters)
    items: list[SyncRunItem] = field(default_factory=list)
    incomplete_reasons: list[str] = field(default_factory=list)
    cancelled: bool = False


class SyncEngine:
    def __init__(self, db: Session, caldav: CalDAVClient, google: GoogleCalendarClient, cancel: threading.Event | None = None) -> None:
        self.db = db
        self.caldav = caldav
        self.google = google
        self.cancel = cancel or threading.Event()
        # The run row this engine created/used; lets the caller mark it failed on errors.
        self.run_row: SyncRun | None = None
        self.pair: SyncPair | None = None
        # No autoflush: pending changes must never hold the SQLite write lock while we wait for
        # the network (a token refresh needs that lock from another session). We commit explicitly.
        self.db.autoflush = False

    # -- helpers ----------------------------------------------------------------------

    def _item(
        self,
        st: _State,
        action: str,
        *,
        title: str | None = None,
        start: str | None = None,
        rid: str | None = None,
        planned: bool = False,
        error: AppError | None = None,
    ) -> None:
        if len(st.items) >= MAX_ITEMS_PER_RUN:
            return
        st.items.append(
            SyncRunItem(
                action=action,
                title=(title or None) and title[:255],
                start_repr=start,
                recurrence_id=rid or None,
                planned_only=planned,
                error_code=error.code if error else None,
                error_params=error.params if error else None,
            )
        )

    def _settings(self) -> AppSettings:
        s = self.db.get(AppSettings, 1)
        if s is None:
            raise AppError("sync.not_configured", 409)
        return s

    # -- entry point ------------------------------------------------------------------

    def should_skip(self, s: AppSettings, pair: SyncPair, ctag: str | None, opts: RunOptions) -> bool:
        if opts.force_full or opts.dry_run or opts.trigger != "schedule":
            return False
        if not ctag or ctag != pair.last_source_ctag or config_hash(s, pair) != pair.last_config_hash:
            return False
        last = pair.last_full_sync_at
        return last is not None and utcnow() - last < FULL_SYNC_EVERY

    def run(self, opts: RunOptions, pair: SyncPair, run: SyncRun | None = None) -> SyncRun | None:
        """Executes one sync of one pair. Returns the persisted run, or None if skipped as unchanged."""
        s = self._settings()
        if not pair.source_calendar_url or not pair.target_calendar_id:
            raise AppError("sync.not_configured", 409)
        self.pair = pair
        source_url, target_id = pair.source_calendar_url, pair.target_calendar_id

        # 1. Verify the source calendar is the configured one and still exists.
        props = self.caldav.collection_props(source_url)
        if props is None or q("D", "resourcetype") not in props.props:
            raise AppError("icloud.calendar_not_found", 404)
        types = [c.tag for c in props.props[q("D", "resourcetype")]]
        if q("C", "calendar") not in types or source_calendar_id(props.href or source_url) != source_calendar_id(source_url):
            raise AppError("icloud.calendar_not_found", 404)
        # Note: ElementTree elements without children are falsy -> compare with None explicitly.
        ctag_el = props.props.get(q("CS", "getctag"))
        if ctag_el is None:
            ctag_el = props.props.get(q("D", "sync-token"))
        ctag = (ctag_el.text or "").strip() if ctag_el is not None else None

        if run is None and self.should_skip(s, pair, ctag, opts):
            pair.last_success_at = s.last_success_at = utcnow()
            self.db.commit()
            return None

        if run is None:
            run = SyncRun(trigger=opts.trigger, dry_run=opts.dry_run, status="running")
            self.db.add(run)
        run.source_calendar_url, run.target_calendar_id = source_url, target_id
        run.pair_id, run.calendar_name = pair.id, pair.source_calendar_name
        self.db.commit()
        self.run_row = run

        # 2. Verify the target calendar.
        entry = self.google.get_calendar_entry(target_id)
        if entry is None:
            raise AppError("google.calendar_not_found", 404)
        if entry.get("accessRole") not in ("owner", "writer"):
            raise AppError("google.calendar_not_writable", 409)
        if entry.get("primary") and not s.allow_primary_target:
            raise AppError("google.primary_locked", 409)

        st = _State()
        pkey = pair_key(source_url, target_id)
        map_opts = MapOptions(default_timezone=s.default_timezone, sync_reminders=s.sync_reminders, sync_descriptions=s.sync_descriptions, pair_key=pkey)

        # 3. Fetch the source window.
        now = utcnow()
        window_start = add_months(now, -s.past_months)
        window_end = add_months(now, s.future_months)
        fetch = self.caldav.fetch_events(source_url, window_start, window_end)
        if not fetch.complete:
            st.incomplete_reasons.extend(sorted(set(fetch.problems)))

        components: dict[tuple[str, str], SourceComponent] = {}
        for res in fetch.resources:
            try:
                parsed = parse_resource(res.data, res.href, res.etag, map_opts)
            except ValueError:
                st.incomplete_reasons.append("parse_error")
                st.counters.failed += 1
                self._item(st, "error", error=AppError("icloud.unexpected_response", params={"reason": "ical"}))
                continue
            for comp in parsed:
                key = (comp.uid, comp.recurrence_id)
                if key in components:
                    st.incomplete_reasons.append("duplicate_uid")
                    continue
                components[key] = comp
        run.source_events = sum(1 for c in components.values() if c.kind != "override")
        self.db.commit()

        mappings: dict[tuple[str, str], EventMapping] = {
            (m.uid, m.recurrence_id): m
            for m in self.db.execute(
                select(EventMapping).where(EventMapping.source_calendar_url == source_url, EventMapping.target_calendar_id == target_id)
            ).scalars()
        }

        # 4. Google side: find managed events that were removed in Google (to recreate them)
        #    and events carrying our marker that we do not know (reported, never deleted).
        google_ids: set[str] | None
        try:
            managed = self.google.list_managed_events(target_id, pkey)
            google_ids = {e["id"] for e in managed if e.get("status") != "cancelled" and not e.get("recurringEventId")}
        except AppError:
            google_ids = None  # not fatal: we just cannot detect manual deletions this time

        # 5. Create / update.
        masters_rewritten: set[str] = set()
        ordered = sorted(components.values(), key=lambda c: (c.kind == "override", c.uid, c.recurrence_id))
        present_keys: set[tuple[str, str]] = set()
        for comp in ordered:
            if self.cancel.is_set():
                st.cancelled = True
                break
            key = (comp.uid, comp.recurrence_id)
            if comp.cancelled and comp.kind != "override":
                continue  # handled as deletion (positive evidence from the source)
            present_keys.add(key)
            mapping = mappings.get(key)
            try:
                if comp.kind == "override":
                    self._sync_override(st, comp, mapping, mappings, masters_rewritten, target_id, pkey, opts)
                else:
                    missing_in_google = google_ids is not None and mapping is not None and mapping.google_event_id not in google_ids
                    rewritten = self._sync_event(st, comp, mapping, mappings, target_id, pkey, opts, force=missing_in_google)
                    if rewritten and comp.kind == "master":
                        masters_rewritten.add(comp.uid)
            except (GoogleReauthRequired, ICloudAuthError):
                raise
            except AppError as exc:
                st.counters.failed += 1
                self._item(st, "error", title=comp.title, start=comp.start_repr, rid=comp.recurrence_id, error=exc)
                if mapping is not None and not opts.dry_run:
                    mapping.status, mapping.last_error_code = "error", exc.code
                    self.db.commit()
                log.warning("component failed", extra={"fields": {"code": exc.code, "uid": short_hash(comp.uid)}})

        # 6. Overrides that disappeared while their master still exists -> reset the instance.
        if not st.cancelled:
            for key, mapping in list(mappings.items()):
                if mapping.kind not in ("override", "detached") or key in present_keys:
                    continue
                master_key = (mapping.uid, "")
                if master_key in present_keys and master_key in components:
                    self._reset_instance(st, mapping, components[master_key], target_id, opts)
                    mappings.pop(key, None)

        # 7. Deletions.
        planned, blocked = 0, False
        if not st.cancelled:
            planned, blocked = self._deletions(st, s, pair, components, present_keys, mappings, target_id, pkey, opts)

        orphans = 0
        if google_ids is not None:
            known = {
                m.google_event_id
                for m in self.db.execute(
                    select(EventMapping).where(EventMapping.source_calendar_url == source_url, EventMapping.target_calendar_id == target_id)
                ).scalars()
            }
            orphans = len(google_ids - known - {google_event_id(pkey, c.uid, c.recurrence_id) for c in components.values()})

        # 8. Finish.
        c = st.counters
        run.created, run.updated, run.deleted, run.unchanged, run.failed = c.created, c.updated, c.deleted, c.unchanged, c.failed
        run.deletions_planned, run.deletions_blocked = planned, blocked
        run.deletions_dry_run = bool(planned) and (opts.dry_run or s.deletion_dry_run)
        run.items = st.items
        params: dict[str, Any] = {}
        if orphans:
            params["orphans"] = orphans
        if st.cancelled:
            run.status, run.message_code = "partial", "sync.cancelled"
        elif st.incomplete_reasons:
            run.status, run.message_code = "partial", "sync.source_incomplete"
            params["reasons"] = sorted(set(st.incomplete_reasons))
        elif blocked:
            run.status, run.message_code = "partial", "sync.deletion_guard_tripped"
            params.update({"planned": planned, "limit_absolute": s.deletion_max_absolute, "limit_percent": s.deletion_max_percent})
        elif c.failed:
            run.status, run.message_code = "partial", "sync.partial_failure"
            params["failed"] = c.failed
        elif run.deletions_dry_run and not opts.dry_run:
            run.status, run.message_code = "success", "sync.deletion_dry_run"
            params["planned"] = planned
        elif c.created + c.updated + c.deleted == 0:
            run.status, run.message_code = "success", "sync.unchanged"
        else:
            run.status, run.message_code = "success", "sync.success"
        run.message_params = params
        run.finished_at = utcnow()

        if not opts.dry_run:
            pair.last_full_sync_at = run.finished_at
            pair.last_config_hash = config_hash(s, pair)
            # Only remember the ctag when everything went through, so a partial run is repeated.
            pair.last_source_ctag = ctag if run.status == "success" else None
            if run.status == "success":
                pair.last_success_at = s.last_success_at = run.finished_at
        self.db.commit()
        return run

    # -- create / update ---------------------------------------------------------------

    def _save_mapping(
        self,
        comp: SourceComponent,
        mapping: EventMapping | None,
        mappings: dict[tuple[str, str], EventMapping],
        gid: str,
        target_id: str,
        source_url: str,
        kind: str,
    ) -> EventMapping:
        if mapping is None:
            mapping = EventMapping(
                source_calendar_url=source_url, target_calendar_id=target_id, uid=comp.uid, recurrence_id=comp.recurrence_id, google_event_id=gid
            )
            self.db.add(mapping)
            mappings[(comp.uid, comp.recurrence_id)] = mapping
        mapping.google_event_id = gid
        mapping.kind = kind
        mapping.source_href, mapping.source_etag = comp.href, comp.etag
        mapping.content_hash = comp.content_hash
        mapping.title, mapping.start_repr = (comp.title or None) and comp.title[:255], comp.start_repr
        mapping.status, mapping.last_error_code = "active", None
        mapping.last_synced_at = utcnow()
        self.db.commit()
        return mapping

    def _source_url(self) -> str:
        return self.pair.source_calendar_url if self.pair is not None else ""

    def _sync_event(
        self,
        st: _State,
        comp: SourceComponent,
        mapping: EventMapping | None,
        mappings: dict[tuple[str, str], EventMapping],
        target_id: str,
        pkey: str,
        opts: RunOptions,
        *,
        force: bool,
    ) -> bool:
        """Returns True when the Google event was written (or would be in dry-run)."""
        if mapping is not None and not force and mapping.status == "active" and mapping.content_hash == comp.content_hash:
            st.counters.unchanged += 1
            if not opts.dry_run and (mapping.source_href != comp.href or mapping.source_etag != comp.etag):
                mapping.source_href, mapping.source_etag = comp.href, comp.etag
                self.db.commit()
            return False

        gid = mapping.google_event_id if mapping is not None else google_event_id(pkey, comp.uid, comp.recurrence_id)
        action = "update" if mapping is not None else "create"
        if opts.dry_run:
            self._item(st, action, title=comp.title, start=comp.start_repr, rid=comp.recurrence_id or None, planned=True)
            setattr(st.counters, "updated" if action == "update" else "created", getattr(st.counters, "updated" if action == "update" else "created") + 1)
            return True

        written = None
        if mapping is not None:
            written = self.google.update_event(target_id, gid, comp.payload)
        if written is None:
            status, _ = self.google.insert_event(target_id, {**comp.payload, "id": gid})
            if status == 409:
                # The id already exists (created earlier, DB lost, or deleted in Google): overwrite it.
                written = self.google.update_event(target_id, gid, comp.payload)
                if written is None:
                    raise AppError("google.api_error", 502, {"status": 409})
                action = "update" if mapping is not None else "create"
        self._save_mapping(comp, mapping, mappings, gid, target_id, self._source_url(), comp.kind)
        self._item(st, action, title=comp.title, start=comp.start_repr, rid=comp.recurrence_id or None)
        if action == "create":
            st.counters.created += 1
        else:
            st.counters.updated += 1
        return True

    def _sync_override(
        self,
        st: _State,
        comp: SourceComponent,
        mapping: EventMapping | None,
        mappings: dict[tuple[str, str], EventMapping],
        masters_rewritten: set[str],
        target_id: str,
        pkey: str,
        opts: RunOptions,
    ) -> None:
        master = mappings.get((comp.uid, ""))
        force = comp.uid in masters_rewritten
        if mapping is not None and not force and mapping.status == "active" and mapping.content_hash == comp.content_hash:
            st.counters.unchanged += 1
            return
        if opts.dry_run:
            self._item(st, "update", title=comp.title, start=comp.start_repr, rid=comp.recurrence_id, planned=True)
            st.counters.updated += 1
            return
        if master is None:
            raise AppError("google.calendar_not_found", 404, {"reason": "master_missing"})

        body = {k: v for k, v in comp.payload.items() if k != "recurrence"}
        if comp.cancelled:
            body = {"status": "cancelled"}

        instance_id = mapping.google_event_id if (mapping is not None and mapping.kind == "override" and not force) else None
        if instance_id is None:
            instance = self.google.find_instance(target_id, master.google_event_id, comp.original_start or "")
            instance_id = instance.get("id") if instance else None

        if instance_id is not None:
            if self.google.patch_event(target_id, instance_id, body) is None:
                instance_id = None
        kind = "override"
        if instance_id is None:
            if comp.cancelled:
                # Occurrence does not exist in Google (already excluded) -> nothing to cancel.
                self._save_mapping(comp, mapping, mappings, google_event_id(pkey, comp.uid, comp.recurrence_id), target_id, self._source_url(), "override")
                st.counters.unchanged += 1
                return
            # Occurrence not generated by the Google series (e.g. moved RDATE) -> standalone copy.
            instance_id = google_event_id(pkey, comp.uid, comp.recurrence_id)
            kind = "detached"
            status, _ = self.google.insert_event(target_id, {**body, "id": instance_id})
            if status == 409:
                self.google.update_event(target_id, instance_id, body)
        self._save_mapping(comp, mapping, mappings, instance_id, target_id, self._source_url(), kind)
        self._item(st, "update", title=comp.title, start=comp.start_repr, rid=comp.recurrence_id)
        st.counters.updated += 1

    def _reset_instance(self, st: _State, mapping: EventMapping, master: SourceComponent, target_id: str, opts: RunOptions) -> None:
        """An exception was removed in iCloud: give the occurrence the series values back."""
        if opts.dry_run:
            self._item(st, "reset_instance", title=master.title, rid=mapping.recurrence_id, planned=True)
            st.counters.updated += 1
            return
        try:
            if mapping.kind == "detached":
                self.google.delete_event(target_id, mapping.google_event_id)
            else:
                body = {k: v for k, v in master.payload.items() if k != "recurrence"}
                start, end = _occurrence_times(master.payload, mapping.recurrence_id)
                body["start"], body["end"], body["status"] = start, end, master.payload.get("status", "confirmed")
                self.google.patch_event(target_id, mapping.google_event_id, body)
        except AppError as exc:
            st.counters.failed += 1
            self._item(st, "error", title=master.title, rid=mapping.recurrence_id, error=exc)
            return
        self.db.delete(mapping)
        self.db.commit()
        self._item(st, "reset_instance", title=master.title, rid=mapping.recurrence_id)
        st.counters.updated += 1

    # -- deletions ---------------------------------------------------------------------

    def _deletions(
        self,
        st: _State,
        s: AppSettings,
        pair: SyncPair,
        components: dict[tuple[str, str], SourceComponent],
        present_keys: set[tuple[str, str]],
        mappings: dict[tuple[str, str], EventMapping],
        target_id: str,
        pkey: str,
        opts: RunOptions,
    ) -> tuple[int, bool]:
        candidates: list[tuple[EventMapping, bool]] = []  # (mapping, cancelled_in_source)
        for key, mapping in mappings.items():
            if mapping.kind == "override":
                continue  # removed together with their master
            if key in present_keys:
                continue
            comp = components.get(key)
            if comp is not None and comp.cancelled:
                candidates.append((mapping, True))
            elif comp is None:
                candidates.append((mapping, False))

        if not candidates:
            return 0, False
        if st.incomplete_reasons:
            for mapping, _ in candidates:
                self._item(st, "skip_delete", title=mapping.title, start=mapping.start_repr, planned=True)
            return 0, False

        # Verify every candidate individually against iCloud.
        confirmed: list[EventMapping] = []
        for mapping, cancelled in candidates:
            if cancelled:
                confirmed.append(mapping)
                continue
            if not mapping.source_href:
                self._item(st, "skip_delete", title=mapping.title, start=mapping.start_repr, planned=True)
                continue
            if not urlparse(mapping.source_href).path.startswith(urlparse(pair.source_calendar_url).path):
                # The href does not belong to the source calendar -> never trust it for a deletion.
                self._item(st, "skip_delete", title=mapping.title, start=mapping.start_repr, planned=True)
                continue
            status, body = self.caldav.get_resource(mapping.source_href)
            if status in (404, 410):
                confirmed.append(mapping)
            elif status == 200 and body is not None and mapping.uid not in body:
                confirmed.append(mapping)  # resource reused for another UID
            elif status == 200:
                # Still exists -> moved out of the sync window (or time-range quirk). Keep it.
                continue
            else:
                st.incomplete_reasons.append(f"verify_status_{status}")
                return 0, False

        planned = len(confirmed)
        if planned == 0:
            return 0, False
        total = max(len([m for m in mappings.values() if m.kind != "override"]), 1)
        source_empty = not any(c.kind != "override" and not c.cancelled for c in components.values())
        too_many = planned > s.deletion_max_absolute or (planned >= PERCENT_GUARD_MIN and planned * 100 / total > s.deletion_max_percent) or source_empty
        blocked = too_many and not opts.allow_mass_deletion
        plan_only = blocked or opts.dry_run or s.deletion_dry_run

        for mapping in confirmed:
            if plan_only:
                self._item(st, "delete", title=mapping.title, start=mapping.start_repr, planned=True)
                continue
            try:
                event = self.google.get_event(target_id, mapping.google_event_id)
                if event is not None:
                    private = (event.get("extendedProperties") or {}).get("private") or {}
                    if private.get("icgs_managed") != "1" or private.get("icgs_pair") != pkey:
                        self._item(st, "skip_delete", title=mapping.title, start=mapping.start_repr, planned=True)
                        continue
                    self.google.delete_event(target_id, mapping.google_event_id)
            except AppError as exc:
                st.counters.failed += 1
                self._item(st, "error", title=mapping.title, start=mapping.start_repr, error=exc)
                continue
            for key, other in list(mappings.items()):
                if other.uid == mapping.uid and other is not mapping and other.kind in ("override",):
                    self.db.delete(other)
                    mappings.pop(key, None)
            self.db.delete(mapping)
            self.db.commit()
            st.counters.deleted += 1
            self._item(st, "delete", title=mapping.title, start=mapping.start_repr)
        return planned, blocked


def _occurrence_times(master_payload: dict[str, Any], rid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    start, end = master_payload["start"], master_payload["end"]
    if "date" in start:
        day = date(int(rid[0:4]), int(rid[4:6]), int(rid[6:8]))
        length = date.fromisoformat(end["date"]) - date.fromisoformat(start["date"])
        return {"date": day.isoformat()}, {"date": (day + length).isoformat()}
    original = datetime.strptime(rid, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    tz_name = start.get("timeZone") or "UTC"
    local = original.astimezone(ZoneInfo(tz_name))
    length_td = datetime.fromisoformat(end["dateTime"]) - datetime.fromisoformat(start["dateTime"])
    return (
        {"dateTime": local.isoformat(), "timeZone": tz_name},
        {"dateTime": (local + length_td).isoformat(), "timeZone": end.get("timeZone") or tz_name},
    )
