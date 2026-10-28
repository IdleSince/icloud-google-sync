"""initial schema

Revision ID: 0001_initial
Revises: 
Create Date: 2026-10-28 21:17:12.352594
"""
from alembic import op
import sqlalchemy as sa


revision = '0001_initial'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('app_settings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('sync_enabled', sa.Boolean(), nullable=False),
    sa.Column('interval_minutes', sa.Integer(), nullable=False),
    sa.Column('past_months', sa.Integer(), nullable=False),
    sa.Column('future_months', sa.Integer(), nullable=False),
    sa.Column('deletion_dry_run', sa.Boolean(), nullable=False),
    sa.Column('deletion_max_absolute', sa.Integer(), nullable=False),
    sa.Column('deletion_max_percent', sa.Integer(), nullable=False),
    sa.Column('sync_reminders', sa.Boolean(), nullable=False),
    sa.Column('sync_descriptions', sa.Boolean(), nullable=False),
    sa.Column('default_timezone', sa.String(length=64), nullable=False),
    sa.Column('allow_primary_target', sa.Boolean(), nullable=False),
    sa.Column('source_calendar_url', sa.String(length=1024), nullable=True),
    sa.Column('source_calendar_name', sa.String(length=255), nullable=True),
    sa.Column('source_calendar_owner', sa.String(length=255), nullable=True),
    sa.Column('source_calendar_shared', sa.Boolean(), nullable=False),
    sa.Column('target_calendar_id', sa.String(length=1024), nullable=True),
    sa.Column('target_calendar_name', sa.String(length=255), nullable=True),
    sa.Column('target_is_primary', sa.Boolean(), nullable=False),
    sa.Column('created_calendar_ids', sa.JSON(), nullable=False),
    sa.Column('last_source_ctag', sa.String(length=255), nullable=True),
    sa.Column('last_config_hash', sa.String(length=64), nullable=True),
    sa.Column('last_full_sync_at', sa.DateTime(), nullable=True),
    sa.Column('last_success_at', sa.DateTime(), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('credentials',
    sa.Column('provider', sa.String(length=16), nullable=False),
    sa.Column('account_enc', sa.Text(), nullable=True),
    sa.Column('secret_enc', sa.Text(), nullable=True),
    sa.Column('access_token_enc', sa.Text(), nullable=True),
    sa.Column('access_expires_at', sa.DateTime(), nullable=True),
    sa.Column('scopes', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=32), nullable=False),
    sa.Column('last_error_code', sa.String(length=64), nullable=True),
    sa.Column('last_checked_at', sa.DateTime(), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('provider')
    )
    op.create_table('event_mappings',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('source_calendar_url', sa.String(length=1024), nullable=False),
    sa.Column('target_calendar_id', sa.String(length=1024), nullable=False),
    sa.Column('uid', sa.String(length=1024), nullable=False),
    sa.Column('recurrence_id', sa.String(length=32), nullable=False),
    sa.Column('source_href', sa.String(length=1024), nullable=True),
    sa.Column('source_etag', sa.String(length=255), nullable=True),
    sa.Column('google_event_id', sa.String(length=1100), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('content_hash', sa.String(length=64), nullable=True),
    sa.Column('title', sa.String(length=255), nullable=True),
    sa.Column('start_repr', sa.String(length=40), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('last_error_code', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('last_synced_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('source_calendar_url', 'target_calendar_id', 'uid', 'recurrence_id', name='uq_mapping_source')
    )
    with op.batch_alter_table('event_mappings', schema=None) as batch_op:
        batch_op.create_index('ix_mapping_google_id', ['google_event_id'], unique=False)
        batch_op.create_index('ix_mapping_pair', ['source_calendar_url', 'target_calendar_id'], unique=False)

    op.create_table('log_entries',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('ts', sa.DateTime(), nullable=False),
    sa.Column('level', sa.String(length=16), nullable=False),
    sa.Column('category', sa.String(length=16), nullable=False),
    sa.Column('code', sa.String(length=64), nullable=False),
    sa.Column('params', sa.JSON(), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('log_entries', schema=None) as batch_op:
        batch_op.create_index('ix_logs_category', ['category'], unique=False)
        batch_op.create_index('ix_logs_level', ['level'], unique=False)
        batch_op.create_index('ix_logs_ts', ['ts'], unique=False)

    op.create_table('oauth_states',
    sa.Column('state_hash', sa.String(length=64), nullable=False),
    sa.Column('session_hash', sa.String(length=64), nullable=False),
    sa.Column('code_verifier_enc', sa.Text(), nullable=False),
    sa.Column('extended', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('state_hash')
    )
    op.create_table('sessions',
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('username', sa.String(length=255), nullable=False),
    sa.Column('csrf_token', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('token_hash')
    )
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.create_index('ix_sessions_expires', ['expires_at'], unique=False)

    op.create_table('sync_locks',
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('owner', sa.String(length=64), nullable=False),
    sa.Column('acquired_at', sa.DateTime(), nullable=False),
    sa.Column('expires_at', sa.DateTime(), nullable=False),
    sa.PrimaryKeyConstraint('name')
    )
    op.create_table('sync_runs',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('trigger', sa.String(length=16), nullable=False),
    sa.Column('dry_run', sa.Boolean(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('started_at', sa.DateTime(), nullable=False),
    sa.Column('finished_at', sa.DateTime(), nullable=True),
    sa.Column('created', sa.Integer(), nullable=False),
    sa.Column('updated', sa.Integer(), nullable=False),
    sa.Column('deleted', sa.Integer(), nullable=False),
    sa.Column('unchanged', sa.Integer(), nullable=False),
    sa.Column('failed', sa.Integer(), nullable=False),
    sa.Column('deletions_planned', sa.Integer(), nullable=False),
    sa.Column('deletions_blocked', sa.Boolean(), nullable=False),
    sa.Column('deletions_dry_run', sa.Boolean(), nullable=False),
    sa.Column('source_events', sa.Integer(), nullable=True),
    sa.Column('message_code', sa.String(length=64), nullable=False),
    sa.Column('message_params', sa.JSON(), nullable=False),
    sa.Column('source_calendar_url', sa.String(length=1024), nullable=True),
    sa.Column('target_calendar_id', sa.String(length=1024), nullable=True),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('sync_runs', schema=None) as batch_op:
        batch_op.create_index('ix_runs_started', ['started_at'], unique=False)
        batch_op.create_index('ix_runs_status', ['status'], unique=False)

    op.create_table('sync_run_items',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('run_id', sa.Integer(), nullable=False),
    sa.Column('action', sa.String(length=16), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=True),
    sa.Column('start_repr', sa.String(length=40), nullable=True),
    sa.Column('recurrence_id', sa.String(length=32), nullable=True),
    sa.Column('planned_only', sa.Boolean(), nullable=False),
    sa.Column('error_code', sa.String(length=64), nullable=True),
    sa.Column('error_params', sa.JSON(), nullable=True),
    sa.ForeignKeyConstraint(['run_id'], ['sync_runs.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    with op.batch_alter_table('sync_run_items', schema=None) as batch_op:
        batch_op.create_index('ix_items_run', ['run_id'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('sync_run_items', schema=None) as batch_op:
        batch_op.drop_index('ix_items_run')

    op.drop_table('sync_run_items')
    with op.batch_alter_table('sync_runs', schema=None) as batch_op:
        batch_op.drop_index('ix_runs_status')
        batch_op.drop_index('ix_runs_started')

    op.drop_table('sync_runs')
    op.drop_table('sync_locks')
    with op.batch_alter_table('sessions', schema=None) as batch_op:
        batch_op.drop_index('ix_sessions_expires')

    op.drop_table('sessions')
    op.drop_table('oauth_states')
    with op.batch_alter_table('log_entries', schema=None) as batch_op:
        batch_op.drop_index('ix_logs_ts')
        batch_op.drop_index('ix_logs_level')
        batch_op.drop_index('ix_logs_category')

    op.drop_table('log_entries')
    with op.batch_alter_table('event_mappings', schema=None) as batch_op:
        batch_op.drop_index('ix_mapping_pair')
        batch_op.drop_index('ix_mapping_google_id')

    op.drop_table('event_mappings')
    op.drop_table('credentials')
    op.drop_table('app_settings')
