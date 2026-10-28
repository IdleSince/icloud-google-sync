from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse

from . import scheduler, services
from .api import auth, google, icloud, status, sync
from .config import APP_VERSION, get_settings
from .db import run_migrations, session_scope
from .errors import AppError
from .logging_setup import log_event, setup_logging
from .security import require_admin

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    setup_logging(settings.log_level)
    settings.encryption_key_bytes()  # fail fast without a valid key
    if not settings.admin_password:
        log.error("ADMIN_PASSWORD(_FILE) is not set - login is impossible until it is configured")
    run_migrations()
    services.recover_interrupted_runs()
    with session_scope() as db:
        interval = services.app_settings(db).interval_minutes
    services.shutdown_event.clear()
    if settings.run_scheduler:
        scheduler.start(interval)
    log_event("info", "system", "system.started", {"version": APP_VERSION})
    try:
        yield
    finally:
        log.info("shutting down: cancelling running sync and stopping scheduler")
        services.shutdown_event.set()
        scheduler.shutdown()
        services.join_threads(timeout=25)
        log_event("info", "system", "system.stopped", {})


def create_app() -> FastAPI:
    app = FastAPI(
        title="iCloud Google Calendar Sync",
        version=APP_VERSION,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse({"error": exc.to_dict()}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = sorted({str(err["loc"][-1]) for err in exc.errors() if err.get("loc")})
        return JSONResponse({"error": {"code": "validation.invalid", "params": {"fields": fields}}}, status_code=422)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", exc_info=exc)
        return JSONResponse({"error": {"code": "internal.error", "params": {}}}, status_code=500)

    @app.middleware("http")
    async def _security_headers(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        response = await call_next(request)
        headers = response.headers
        headers.setdefault("X-Content-Type-Options", "nosniff")
        headers.setdefault("Referrer-Policy", "no-referrer")
        headers.setdefault("X-Frame-Options", "DENY")
        headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
        headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
            "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        )
        if get_settings().secure_cookies:
            headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        if request.url.path.startswith("/api/"):
            headers.setdefault("Cache-Control", "no-store")
        return response

    for router in (status.public, auth.router, status.router, icloud.router, google.router, sync.router):
        app.include_router(router)

    @app.get("/api/openapi.json", include_in_schema=False, dependencies=[Depends(require_admin)])
    def _openapi() -> dict[str, Any]:
        return app.openapi()

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    dist = Path(get_settings().frontend_dist)
    index = dist / "index.html"

    @app.get("/{path:path}", include_in_schema=False)
    def _spa(path: str) -> Response:
        if path.startswith("api/") or path == "api":
            return JSONResponse({"error": {"code": "validation.invalid", "params": {"fields": ["path"]}}}, status_code=404)
        if not index.is_file():
            return JSONResponse({"error": {"code": "internal.error", "params": {"reason": "frontend_missing"}}}, status_code=503)
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            cache = "public, max-age=31536000, immutable" if "/assets/" in f"/{path}" else "no-cache"
            return FileResponse(candidate, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
