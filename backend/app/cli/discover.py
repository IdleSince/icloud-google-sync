"""Phase-1 feasibility tool: lists every calendar your Apple ID can reach via CalDAV.

Usage (inside the container or a local venv):

    python -m app.cli.discover            # prompts for Apple ID + app-specific password
    python -m app.cli.discover --json     # machine readable output
    python -m app.cli.discover --raw      # include sanitized CalDAV properties

Credentials are read from the prompt (or ICLOUD_APPLE_ID / ICLOUD_APP_PASSWORD) and
never written anywhere. Nothing is modified on iCloud: only PROPFIND/REPORT requests.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import sys

from ..caldav.client import CalDAVClient
from ..caldav.discovery import diagnose
from ..config import get_settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="iCloud CalDAV calendar discovery (read-only)")
    parser.add_argument("--json", action="store_true", help="print JSON instead of a table")
    parser.add_argument("--raw", action="store_true", help="include sanitized CalDAV properties")
    args = parser.parse_args(argv)

    apple_id = os.environ.get("ICLOUD_APPLE_ID") or input("Apple ID (e-mail): ").strip()
    password = os.environ.get("ICLOUD_APP_PASSWORD") or getpass.getpass("App-specific password (xxxx-xxxx-xxxx-xxxx): ").strip()
    settings = get_settings()

    with CalDAVClient(apple_id, password, base_url=settings.icloud_caldav_url, allowed_host_suffix=settings.icloud_allowed_host_suffix) as client:
        result = diagnose(client)

    if not args.raw:
        result.pop("raw", None)
    if args.json:
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0 if result["conclusion"] == "shared_accessible" else 1

    print("\nDiagnosis steps")
    for step in result["steps"]:
        params = ", ".join(f"{k}={v}" for k, v in step["params"].items())
        print(f"  [{step['status']:>7}] {step['key']:<16} {params}")

    print("\nCalendars")
    header = f"  {'name':<28} {'ownership':<9} {'owner':<22} {'access':<10} {'events':>6}  readable  id"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for cal in result["calendars"]:
        events = "-" if cal["event_count"] is None else str(cal["event_count"])
        error = f"  ({cal['error']['code']})" if cal["error"] else ""
        print(
            f"  {cal['name'][:28]:<28} {cal['ownership']:<9} {(cal['owner'] or '-')[:22]:<22} "
            f"{cal['access']:<10} {events:>6}  {'yes' if cal['readable'] else 'no':<8}  {cal['id']}{error}"
        )
        print(f"      {cal['url']}")

    conclusion = result["conclusion"]
    print(f"\nConclusion: {conclusion}")
    explanations = {
        "shared_accessible": "At least one calendar shared with you is listed and readable via CalDAV. The sync can use it.",
        "shared_not_listed": (
            "No calendar marked as shared was found. Check that the invitation was accepted on your iPhone "
            "(Calendar > Calendars) and that the calendar is visible on icloud.com/calendar. "
            "A public link is NOT a valid workaround for this app."
        ),
        "shared_not_readable": "Shared calendars are listed but cannot be read with this account.",
        "auth_failed": "Apple rejected the credentials. Use an app-specific password, not your Apple ID password.",
        "unreachable": "iCloud CalDAV could not be reached. Check network/DNS/proxy.",
        "not_configured": "No credentials given.",
    }
    print(explanations.get(conclusion, ""))
    return 0 if conclusion == "shared_accessible" else 1


if __name__ == "__main__":
    raise SystemExit(main())
