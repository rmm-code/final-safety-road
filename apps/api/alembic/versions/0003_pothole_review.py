"""An operator's review of a pothole, kept on the pothole.

Revision ID: 0003
Revises: 0002

Review used to leave a trace only when it changed the status: "False positive" wrote a
status-history row, "Correct" wrote nothing at all, so a confirmed pothole came back to
the queue the next time and the confirmation could never become training data. A review
is not a status change - it is a verdict on whether the detector was right - so it lives
in its own columns rather than as a history row whose old and new status are equal.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("potholes", sa.Column("reviewed_at", sa.DateTime(timezone=True)))
    op.add_column(
        "potholes",
        sa.Column(
            "reviewed_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
        ),
    )
    op.add_column("potholes", sa.Column("review_verdict", sa.String(32)))
    # The queue asks for the unreviewed ones, so that is the index it needs.
    op.create_index(
        "ix_potholes_unreviewed",
        "potholes",
        ["last_seen_at"],
        postgresql_where=sa.text("reviewed_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_potholes_unreviewed", table_name="potholes")
    op.drop_column("potholes", "review_verdict")
    op.drop_column("potholes", "reviewed_by")
    op.drop_column("potholes", "reviewed_at")
