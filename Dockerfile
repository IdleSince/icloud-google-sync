# syntax=docker/dockerfile:1.7
# Multi-stage build: 1) frontend bundle, 2) Python virtualenv, 3) slim runtime as non-root user.

ARG NODE_IMAGE=node:24-alpine
ARG PYTHON_IMAGE=python:3.13-slim

# ---------- 1. Frontend ----------------------------------------------------------------
FROM ${NODE_IMAGE} AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---------- 2. Python dependencies -----------------------------------------------------
FROM ${PYTHON_IMAGE} AS backend-deps
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
RUN python -m venv /venv
COPY backend/requirements.txt /tmp/requirements.txt
RUN /venv/bin/pip install -r /tmp/requirements.txt

# ---------- 3. Runtime -----------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
LABEL org.opencontainers.image.title="icloud-google-calendar-sync" \
      org.opencontainers.image.description="One-way sync of a private iCloud calendar into a Google calendar" \
      org.opencontainers.image.version="1.0.0"

ENV PATH="/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL="sqlite:////data/icgs.db" \
    FRONTEND_DIST="/app/frontend/dist" \
    FORWARDED_ALLOW_IPS="127.0.0.1"

RUN groupadd --system --gid 10001 app \
 && useradd --system --uid 10001 --gid app --home-dir /app --shell /usr/sbin/nologin app \
 && mkdir -p /data && chown app:app /data

WORKDIR /app
COPY --from=backend-deps /venv /venv
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./alembic.ini
COPY --from=frontend /build/dist ./frontend/dist

USER 10001:10001
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"]

# uvicorn reads FORWARDED_ALLOW_IPS from the environment (trusted reverse proxy addresses).
# SIGTERM -> graceful shutdown: running sync is cancelled cleanly, scheduler stopped.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-server-header", "--timeout-graceful-shutdown", "30"]
