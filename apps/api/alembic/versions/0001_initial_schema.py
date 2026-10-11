"""Initial schema with PostGIS.

Revision ID: 0001
Revises:
"""

from __future__ import annotations

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Spatial queries are the point of this database, not an add-on.
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("role", sa.String(32), nullable=False, server_default="driver"),
        sa.Column("password_hash", sa.String(128), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_users_email", "users", ["email"])

    op.create_table(
        "devices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_name", sa.String(200), nullable=False),
        sa.Column("platform", sa.String(100)),
        sa.Column("browser", sa.String(200)),
        sa.Column("last_seen_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_devices_user_id", "devices", ["user_id"])

    op.create_table(
        "drive_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("devices.id", ondelete="SET NULL")),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("status", sa.String(32), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_drive_sessions_user_id", "drive_sessions", ["user_id"])

    op.create_table(
        "potholes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("location", geoalchemy2.Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("location_accuracy_m", sa.Numeric(8, 2), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False, server_default="unknown"),
        sa.Column("severity_score", sa.Numeric(6, 4), nullable=False, server_default="0"),
        sa.Column("status", sa.String(32), nullable=False, server_default="active"),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sighting_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("primary_image_key", sa.Text()),
        sa.Column("road_name", sa.Text()),
        sa.Column("road_segment_id", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_potholes_status", "potholes", ["status"])
    op.create_index("ix_potholes_status_last_seen", "potholes", ["status", "last_seen_at"])

    op.create_table(
        "detection_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("pothole_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("potholes.id", ondelete="SET NULL")),
        sa.Column("drive_session_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("drive_sessions.id", ondelete="CASCADE"), nullable=False),
        # Unique: this is what makes upload retries idempotent.
        sa.Column("client_event_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("location", geoalchemy2.Geography(geometry_type="POINT", srid=4326), nullable=False),
        sa.Column("location_accuracy_m", sa.Numeric(8, 2), nullable=False),
        sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("confidence", sa.Numeric(6, 4), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("severity_score", sa.Numeric(6, 4), nullable=False),
        sa.Column("severity_confidence", sa.Numeric(6, 4)),
        sa.Column("heading_deg", sa.Numeric(6, 2)),
        sa.Column("speed_mps", sa.Numeric(7, 3)),
        sa.Column("model_version", sa.String(120), nullable=False),
        sa.Column("full_image_key", sa.Text()),
        sa.Column("crop_image_key", sa.Text()),
        sa.Column("metadata", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_detection_events_pothole_id", "detection_events", ["pothole_id"])
    op.create_index("ix_detection_events_drive_session_id", "detection_events", ["drive_session_id"])
    op.create_index("ix_detection_events_client_event_id", "detection_events", ["client_event_id"])
    op.create_index("ix_detection_events_detected_at", "detection_events", ["detected_at"])
    op.create_index("ix_detection_events_model_version", "detection_events", ["model_version"])

    op.create_table(
        "pothole_status_history",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("pothole_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("potholes.id", ondelete="CASCADE"), nullable=False),
        sa.Column("old_status", sa.String(32)),
        sa.Column("new_status", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text()),
        sa.Column("changed_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_pothole_status_history_pothole_id", "pothole_status_history", ["pothole_id"])

    op.create_table(
        "model_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("version", sa.String(60), nullable=False),
        sa.Column("task", sa.String(32), nullable=False, server_default="detect"),
        sa.Column("dataset_version", sa.String(120)),
        sa.Column("metrics", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("name", "version", name="uq_model_versions_name_version"),
    )

    # GiST indexes: every map viewport query and every dedup lookup depends on these.
    op.execute("CREATE INDEX ix_potholes_location ON potholes USING GIST (location)")
    op.execute("CREATE INDEX ix_detection_events_location ON detection_events USING GIST (location)")


def downgrade() -> None:
    op.drop_table("model_versions")
    op.drop_table("pothole_status_history")
    op.drop_table("detection_events")
    op.drop_table("potholes")
    op.drop_table("drive_sessions")
    op.drop_table("devices")
    op.drop_table("users")
