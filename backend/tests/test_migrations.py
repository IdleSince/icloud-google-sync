from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

from app.models import Base

BASE = Path(__file__).resolve().parent.parent


def _config(url: str) -> Config:
    cfg = Config(str(BASE / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE / "alembic"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def test_upgrade_downgrade_roundtrip(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path.as_posix()}/m.db"
    cfg = _config(url)
    command.upgrade(cfg, "head")
    engine = create_engine(url)
    assert "event_mappings" in inspect(engine).get_table_names()
    command.downgrade(cfg, "base")
    assert set(inspect(engine).get_table_names()) <= {"alembic_version"}
    command.upgrade(cfg, "head")
    engine.dispose()


def test_models_match_migrations(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path.as_posix()}/c.db"
    command.upgrade(_config(url), "head")
    engine = create_engine(url)
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    engine.dispose()
    assert diff == [], f"models and migrations differ: {diff}"


def test_single_calendar_setup_becomes_pair_one_and_back(tmp_path: Path) -> None:
    from sqlalchemy import text

    url = f"sqlite:///{tmp_path.as_posix()}/p.db"
    cfg = _config(url)
    command.upgrade(cfg, "0001_initial")
    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO app_settings (id, sync_enabled, interval_minutes, past_months, future_months, deletion_dry_run, "
                "deletion_max_absolute, deletion_max_percent, sync_reminders, sync_descriptions, default_timezone, "
                "allow_primary_target, source_calendar_url, source_calendar_name, source_calendar_owner, source_calendar_shared, "
                "target_calendar_id, target_calendar_name, target_is_primary, created_calendar_ids, updated_at) VALUES "
                "(1, 1, 5, 12, 24, 0, 25, 30, 1, 1, 'Europe/Berlin', 0, 'https://x.icloud.com/c/a/', 'Arbeit', 'anna@example.com', 1, "
                "'t@group.calendar.google.com', 'Arbeit (anna@example.com)', 0, '[]', '2026-10-28 10:00:00')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO sync_runs (id, trigger, dry_run, status, started_at, created, updated, deleted, unchanged, failed, "
                "deletions_planned, deletions_blocked, deletions_dry_run, message_code, message_params) VALUES "
                "(7, 'manual', 0, 'success', '2026-10-28 10:00:00', 1, 0, 0, 0, 0, 0, 0, 0, 'sync.success', '{}')"
            )
        )
        conn.execute(text("INSERT INTO sync_run_items (run_id, action, planned_only) VALUES (7, 'create', 0)"))
    command.upgrade(cfg, "head")
    with engine.connect() as conn:
        pair = conn.execute(text("SELECT id, source_calendar_url, source_calendar_owner, target_calendar_id FROM sync_pairs")).one()
        assert tuple(pair) == (1, "https://x.icloud.com/c/a/", "anna@example.com", "t@group.calendar.google.com")
        assert conn.execute(text("SELECT pair_id FROM sync_runs WHERE id = 7")).scalar_one() == 1
        assert conn.execute(text("SELECT count(*) FROM sync_run_items")).scalar_one() == 1, "run items must survive"
    command.downgrade(cfg, "0001_initial")
    with engine.connect() as conn:
        row = conn.execute(text("SELECT source_calendar_url, target_calendar_id FROM app_settings WHERE id = 1")).one()
        assert tuple(row) == ("https://x.icloud.com/c/a/", "t@group.calendar.google.com")
        assert conn.execute(text("SELECT count(*) FROM sync_run_items")).scalar_one() == 1
    engine.dispose()
