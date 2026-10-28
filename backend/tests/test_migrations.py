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
