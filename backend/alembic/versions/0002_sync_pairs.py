"""several calendar pairs instead of one source/target in app_settings

Revision ID: 0002_sync_pairs
Revises: 0001_initial
Create Date: 2026-10-29 10:00:00
"""

from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "0002_sync_pairs"
down_revision = "0001_initial"
branch_labels = None
depends_on = None

MOVED_COLUMNS = (
    ("source_calendar_url", sa.String(length=1024)),
    ("source_calendar_name", sa.String(length=255)),
    ("source_calendar_owner", sa.String(length=255)),
    ("target_calendar_id", sa.String(length=1024)),
    ("target_calendar_name", sa.String(length=255)),
    ("last_source_ctag", sa.String(length=255)),
    ("last_config_hash", sa.String(length=64)),
    ("last_full_sync_at", sa.DateTime()),
)
MOVED_FLAGS = ("source_calendar_shared", "target_is_primary")


def upgrade() -> None:
    op.create_table(
        "sync_pairs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("source_calendar_url", sa.String(length=1024), nullable=False),
        sa.Column("source_calendar_name", sa.String(length=255), nullable=True),
        sa.Column("source_calendar_owner", sa.String(length=255), nullable=True),
        sa.Column("source_calendar_shared", sa.Boolean(), nullable=False),
        sa.Column("target_calendar_id", sa.String(length=1024), nullable=True),
        sa.Column("target_calendar_name", sa.String(length=255), nullable=True),
        sa.Column("target_is_primary", sa.Boolean(), nullable=False),
        sa.Column("last_source_ctag", sa.String(length=255), nullable=True),
        sa.Column("last_config_hash", sa.String(length=64), nullable=True),
        sa.Column("last_full_sync_at", sa.DateTime(), nullable=True),
        sa.Column("last_success_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_calendar_url", name="uq_pair_source"),
    )

    # Carry over an existing single source/target configuration as pair 1.
    conn = op.get_bind()
    row = conn.execute(
        sa.text(
            "SELECT source_calendar_url, source_calendar_name, source_calendar_owner, source_calendar_shared, "
            "target_calendar_id, target_calendar_name, target_is_primary, last_source_ctag, last_config_hash, "
            "last_full_sync_at, last_success_at FROM app_settings WHERE id = 1"
        )
    ).mappings().first()
    if row is not None and row["source_calendar_url"]:
        now = datetime.now(UTC).replace(tzinfo=None)
        conn.execute(
            sa.text(
                "INSERT INTO sync_pairs (id, enabled, source_calendar_url, source_calendar_name, source_calendar_owner, "
                "source_calendar_shared, target_calendar_id, target_calendar_name, target_is_primary, last_source_ctag, "
                "last_config_hash, last_full_sync_at, last_success_at, created_at, updated_at) VALUES (1, 1, :su, :sn, :so, "
                ":ss, :ti, :tn, :tp, NULL, NULL, :lf, :ls, :now, :now)"
            ),
            {
                "su": row["source_calendar_url"],
                "sn": row["source_calendar_name"],
                "so": row["source_calendar_owner"],
                "ss": bool(row["source_calendar_shared"]),
                "ti": row["target_calendar_id"],
                "tn": row["target_calendar_name"],
                "tp": bool(row["target_is_primary"]),
                "lf": row["last_full_sync_at"],
                "ls": row["last_success_at"],
                "now": now,
            },
        )

    # app_settings has no foreign keys pointing at it, so the SQLite table copy is safe here.
    with op.batch_alter_table("app_settings") as batch:
        for name, _type in MOVED_COLUMNS:
            batch.drop_column(name)
        for name in MOVED_FLAGS:
            batch.drop_column(name)

    # Plain columns (no FK constraint): sync_runs is the parent of sync_run_items (ON DELETE
    # CASCADE), so recreating it with a batch copy would wipe the run items.
    op.add_column("sync_runs", sa.Column("pair_id", sa.Integer(), nullable=True))
    op.add_column("sync_runs", sa.Column("calendar_name", sa.String(length=255), nullable=True))
    op.execute("UPDATE sync_runs SET pair_id = 1 WHERE EXISTS (SELECT 1 FROM sync_pairs WHERE id = 1)")


def downgrade() -> None:
    op.drop_column("sync_runs", "calendar_name")
    op.drop_column("sync_runs", "pair_id")

    with op.batch_alter_table("app_settings") as batch:
        for name, type_ in MOVED_COLUMNS:
            batch.add_column(sa.Column(name, type_, nullable=True))
        for name in MOVED_FLAGS:
            batch.add_column(sa.Column(name, sa.Boolean(), nullable=False, server_default=sa.false()))

    # Only one pair fits the old layout: keep the oldest one.
    op.execute(
        "UPDATE app_settings SET "
        "source_calendar_url = (SELECT source_calendar_url FROM sync_pairs ORDER BY id LIMIT 1), "
        "source_calendar_name = (SELECT source_calendar_name FROM sync_pairs ORDER BY id LIMIT 1), "
        "source_calendar_owner = (SELECT source_calendar_owner FROM sync_pairs ORDER BY id LIMIT 1), "
        "source_calendar_shared = COALESCE((SELECT source_calendar_shared FROM sync_pairs ORDER BY id LIMIT 1), 0), "
        "target_calendar_id = (SELECT target_calendar_id FROM sync_pairs ORDER BY id LIMIT 1), "
        "target_calendar_name = (SELECT target_calendar_name FROM sync_pairs ORDER BY id LIMIT 1), "
        "target_is_primary = COALESCE((SELECT target_is_primary FROM sync_pairs ORDER BY id LIMIT 1), 0) "
        "WHERE id = 1"
    )
    op.drop_table("sync_pairs")
