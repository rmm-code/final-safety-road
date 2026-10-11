"""Citizen reports from Telegram, and the drafts the bot conversation needs.

Revision ID: 0002
Revises: 0001

`potholes.status` gains the value "reported" but needs no schema change: the column is a
plain String(32) with no check constraint, and the allowed values live in
`app.models.pothole.POTHOLE_STATUSES` rather than in the database. Existing rows keep the
status they have - nothing is reclassified by this migration.
"""

from __future__ import annotations

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "citizen_reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "pothole_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("potholes.id", ondelete="SET NULL"),
        ),
        sa.Column("client_report_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("telegram_user_id", sa.BigInteger()),
        sa.Column("telegram_username", sa.String(64)),
        sa.Column("telegram_chat_id", sa.BigInteger()),
        sa.Column(
            "location",
            geoalchemy2.Geography(geometry_type="POINT", srid=4326),
            nullable=False,
        ),
        sa.Column("location_accuracy_m", sa.Numeric(8, 2), nullable=False),
        sa.Column("reported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("comment", sa.Text()),
        sa.Column("image_key", sa.Text()),
        sa.Column("review_state", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("review_note", sa.Text()),
        sa.Column(
            "reviewed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
        ),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_citizen_reports_pothole_id", "citizen_reports", ["pothole_id"])
    op.create_index("ix_citizen_reports_client_report_id", "citizen_reports", ["client_report_id"])
    op.create_index("ix_citizen_reports_telegram_user_id", "citizen_reports", ["telegram_user_id"])
    op.create_index("ix_citizen_reports_reported_at", "citizen_reports", ["reported_at"])
    op.create_index("ix_citizen_reports_review_state", "citizen_reports", ["review_state"])
    op.create_index(
        "ix_citizen_reports_state_created", "citizen_reports", ["review_state", "created_at"]
    )
    # Reports are matched to potholes by proximity on every submission, so this index is
    # load-bearing for the same reason the one on potholes is.
    op.create_index(
        "ix_citizen_reports_location", "citizen_reports", ["location"], postgresql_using="gist"
    )

    op.create_table(
        "telegram_report_drafts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("chat_id", sa.BigInteger(), nullable=False, unique=True),
        sa.Column("telegram_user_id", sa.BigInteger()),
        sa.Column("telegram_username", sa.String(64)),
        sa.Column("photo_file_id", sa.Text()),
        sa.Column("latitude", sa.Numeric(9, 6)),
        sa.Column("longitude", sa.Numeric(9, 6)),
        sa.Column("location_accuracy_m", sa.Numeric(8, 2)),
        sa.Column("comment", sa.Text()),
        sa.Column("origin_message_id", sa.BigInteger()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_telegram_report_drafts_chat_id", "telegram_report_drafts", ["chat_id"])


def downgrade() -> None:
    op.drop_table("telegram_report_drafts")
    op.drop_table("citizen_reports")
