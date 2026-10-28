from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from app.db import session_scope
from app.main import create_app
from app.models import Credential, OAuthState

from .conftest import TARGET
from .fakes import APP_PASSWORD, APPLE_ID, FakeGoogle, FakeICloud

PASSWORD = "correct horse battery staple"


@pytest.fixture
def client() -> TestClient:
    with TestClient(create_app(), base_url="http://testserver") as c:
        yield c  # type: ignore[misc]


def login(c: TestClient) -> str:
    r = c.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert r.status_code == 200, r.text
    return str(r.json()["csrf_token"])


ADMIN_ENDPOINTS = [
    ("GET", "/api/status"),
    ("GET", "/api/logs"),
    ("GET", "/api/stats"),
    ("GET", "/api/diagnostics"),
    ("GET", "/api/openapi.json"),
    ("GET", "/api/icloud/calendars"),
    ("GET", "/api/icloud/diagnostics"),
    ("PUT", "/api/icloud/credentials"),
    ("PUT", "/api/icloud/source"),
    ("POST", "/api/google/oauth/start"),
    ("GET", "/api/google/calendars"),
    ("PUT", "/api/google/target"),
    ("DELETE", "/api/google/connection"),
    ("GET", "/api/sync/settings"),
    ("PUT", "/api/sync/settings"),
    ("POST", "/api/sync/runs"),
    ("GET", "/api/sync/runs"),
]


@pytest.mark.parametrize(("method", "path"), ADMIN_ENDPOINTS)
def test_admin_endpoints_require_login(client: TestClient, method: str, path: str) -> None:
    r = client.request(method, path, json={})
    assert r.status_code == 401
    assert r.json() == {"error": {"code": "auth.required", "params": {}}}


def test_health_is_public_and_headers_are_set(client: TestClient) -> None:
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["cache-control"] == "no-store"


def test_login_logout_and_csrf(client: TestClient) -> None:
    assert client.get("/api/auth/session").json()["authenticated"] is False
    token = login(client)
    assert client.get("/api/auth/session").json() == {"authenticated": True, "username": "admin", "csrf_token": token}
    assert client.put("/api/sync/settings", json={"interval_minutes": 10}).json()["error"]["code"] == "auth.csrf_invalid"
    assert client.put("/api/sync/settings", json={"interval_minutes": 10}, headers={"X-CSRF-Token": "nope"}).status_code == 403
    ok = client.put("/api/sync/settings", json={"interval_minutes": 10}, headers={"X-CSRF-Token": token})
    assert ok.status_code == 200 and ok.json()["interval_minutes"] == 10
    foreign = client.put("/api/sync/settings", json={}, headers={"X-CSRF-Token": token, "Origin": "https://evil.example"})
    assert foreign.status_code == 403
    assert client.post("/api/auth/logout", headers={"X-CSRF-Token": token}).status_code == 204
    assert client.get("/api/status").status_code == 401


def test_session_cookie_flags(client: TestClient) -> None:
    r = client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie


def test_login_throttling(client: TestClient) -> None:
    for _ in range(5):
        assert client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code == 401
    r = client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert r.status_code == 429 and r.json()["error"]["code"] == "auth.rate_limited"
    assert r.json()["error"]["params"]["retry_after_seconds"] > 0


def test_settings_validation(client: TestClient) -> None:
    token = login(client)
    h = {"X-CSRF-Token": token}
    assert client.put("/api/sync/settings", json={"interval_minutes": 0}, headers=h).json()["error"] == {
        "code": "validation.invalid",
        "params": {"fields": ["interval_minutes"]},
    }
    assert client.put("/api/sync/settings", json={"default_timezone": "Mars/Base"}, headers=h).status_code == 422
    body = client.put("/api/sync/settings", json={"past_months": 6, "future_months": 36, "deletion_max_percent": 10}, headers=h).json()
    assert (body["past_months"], body["future_months"], body["deletion_max_percent"]) == (6, 36, 10)


def test_icloud_credentials_reject_normal_password(client: TestClient, icloud: FakeICloud) -> None:
    h = {"X-CSRF-Token": login(client)}
    r = client.put("/api/icloud/credentials", json={"apple_id": APPLE_ID, "app_password": "MyNormalPassword1!"}, headers=h)
    assert r.json()["error"]["code"] == "icloud.invalid_app_password_format"
    r = client.put("/api/icloud/credentials", json={"apple_id": "no-email", "app_password": APP_PASSWORD}, headers=h)
    assert r.json()["error"]["code"] == "icloud.invalid_apple_id"
    r = client.put("/api/icloud/credentials", json={"apple_id": APPLE_ID, "app_password": "zzzz-zzzz-zzzz-zzzz"}, headers=h)
    assert r.json()["error"]["code"] == "icloud.auth_failed"


def test_icloud_setup_flow_and_secret_never_returned(client: TestClient, icloud: FakeICloud) -> None:
    h = {"X-CSRF-Token": login(client)}
    r = client.put("/api/icloud/credentials", json={"apple_id": APPLE_ID, "app_password": APP_PASSWORD.upper()}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["account_masked"] == "te***@icloud.com"
    with session_scope() as db:
        cred = db.get(Credential, "icloud")
        assert cred is not None and APP_PASSWORD not in (cred.secret_enc or "") and APPLE_ID not in (cred.account_enc or "")
    cals = client.get("/api/icloud/calendars").json()["calendars"]
    shared = next(c for c in cals if c["ownership"] == "shared")
    assert "raw" not in shared and "ctag" not in shared
    r = client.put("/api/icloud/source", json={"calendar_url": shared["url"]}, headers=h)
    assert r.json()["source"]["shared"] is True and r.json()["source"]["id"] == shared["id"]
    assert client.put("/api/icloud/source", json={"calendar_url": "https://p42-caldav.icloud.com/x/y/"}, headers=h).status_code == 404
    diag = client.get("/api/icloud/diagnostics").json()
    assert diag["conclusion"] == "shared_accessible"
    status = client.get("/api/status").text
    assert APP_PASSWORD not in status


def test_google_oauth_state_and_pkce(client: TestClient, google: FakeGoogle) -> None:
    h = {"X-CSRF-Token": login(client)}
    url = client.post("/api/google/oauth/start", json={"extended": False}, headers=h).json()["authorization_url"]
    q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
    assert q["access_type"] == "offline" and q["code_challenge_method"] == "S256"
    assert q["redirect_uri"] == "http://testserver/api/google/oauth/callback"
    assert "calendar.events.owned" not in q["scope"] and "calendar.app.created" in q["scope"]

    bad = client.get("/api/google/oauth/callback", params={"state": "forged", "code": "good-code"}, follow_redirects=False)
    assert bad.status_code == 302 and "error=google.oauth_state_invalid" in bad.headers["location"]

    ok = client.get("/api/google/oauth/callback", params={"state": q["state"], "code": "good-code"}, follow_redirects=False)
    assert ok.status_code == 302 and ok.headers["location"].endswith("/google?connected=1")
    replay = client.get("/api/google/oauth/callback", params={"state": q["state"], "code": "good-code"}, follow_redirects=False)
    assert "oauth_state_invalid" in replay.headers["location"], "state must be single-use"
    with session_scope() as db:
        assert db.query(OAuthState).count() == 0

    status = client.get("/api/status").json()["google"]
    assert status["connected"] and status["account"] == "me@example.com" and status["extended_access"] is False


def test_google_calendar_selection_and_primary_lock(client: TestClient, configured: None, google: FakeGoogle) -> None:
    h = {"X-CSRF-Token": login(client)}
    cals = {c["id"]: c for c in client.get("/api/google/calendars").json()["calendars"]}
    assert cals["me@example.com"]["lock_reason"] == "primary_locked"
    assert cals["readonly@group.calendar.google.com"]["lock_reason"] == "not_writable"
    assert cals[TARGET]["selectable"] and cals[TARGET]["selected"]

    r = client.put("/api/google/target", json={"calendar_id": "me@example.com", "confirm_primary": True}, headers=h)
    assert r.json()["error"]["code"] == "google.primary_locked"

    created = client.post("/api/google/calendars", json={}, headers=h).json()["calendar"]
    assert created["name"] == "iCloud Sync" and created["created_by_app"] and created["selected"]
    assert client.get("/api/status").json()["target"]["id"] == created["id"]


def test_sync_run_endpoint(client: TestClient, configured: None, icloud: FakeICloud, google: FakeGoogle) -> None:
    from app import services

    h = {"X-CSRF-Token": login(client)}
    r = client.post("/api/sync/runs", json={"dry_run": True}, headers=h)
    assert r.status_code == 202
    run_id = r.json()["run_id"]
    services.join_threads(10)
    detail = client.get(f"/api/sync/runs/{run_id}").json()
    assert detail["status"] == "success" and detail["dry_run"] is True and detail["trigger"] == "dry_run"
    runs = client.get("/api/sync/runs").json()
    assert runs["total"] == 1
    assert client.get("/api/sync/state").json()["running"] is False
    stats = client.get("/api/stats", params={"days": 7}).json()["days"]
    assert len(stats) == 7 and stats[-1]["runs"] == 1


def test_unknown_api_path_is_json_404(client: TestClient) -> None:
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404 and r.json()["error"]["code"] == "validation.invalid"


def test_spa_fallback_without_build(client: TestClient) -> None:
    assert client.get("/dashboard").status_code == 503
