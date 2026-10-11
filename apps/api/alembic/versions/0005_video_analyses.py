"""Saved video analyses: road videos analysed in a browser, kept for everyone to replay.

Revision ID: 0005
Revises: 0004

Two tables. `video_analyses` is one analysed clip: how it was analysed, which of its stored
objects (overlay, poster, video) have finished uploading, and an optional hand-placed
location. `video_analysis_potholes` is one pothole track found in it, with its crop and
full frame.

Neither table is a sighting. A video file carries no GPS, so its location is a point a
person placed for the whole clip. It never goes through dedup and never creates a
`detection_events` or `potholes` row: merging every pothole of a clip into one hand-placed
point, and tightening its accuracy on each merge, would put fabricated precision on the
map.

The location column gets ONE GiST index, created explicitly. Declaring the column with
geoalchemy2's default `spatial_index=True` also creates `idx_<table>_location`, which is why
`potholes`, `detection_events` and `citizen_reports` each carry two identical GiST indexes.

Autogenerate also proposed dropping PostGIS's own tables (`spatial_ref_sys`, the tiger
geocoder's) and swapping several unique constraints for unique indexes. None of that is
this change, and it has been removed.
"""

from __future__ import annotations

import geoalchemy2
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "video_analyses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
        ),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("file_name", sa.String(255), nullable=False),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("demo_video_path", sa.Text()),
        sa.Column("demo_poster_path", sa.Text()),
        sa.Column("video_content_type", sa.String(64)),
        sa.Column("recorded_at", sa.DateTime(timezone=True)),
        sa.Column("duration_seconds", sa.Double(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("model_version", sa.String(120), nullable=False),
        sa.Column("confidence_threshold", sa.Double(), nullable=False),
        sa.Column("sample_fps", sa.Double(), nullable=False),
        sa.Column("frames_analysed", sa.Integer(), nullable=False),
        sa.Column("raw_detections", sa.Integer(), nullable=False),
        sa.Column("rejected_tracks", sa.Integer(), nullable=False),
        sa.Column("average_inference_ms", sa.Double(), nullable=False),
        sa.Column("overlay_key", sa.Text()),
        sa.Column("overlay_uploaded_at", sa.DateTime(timezone=True)),
        sa.Column("poster_key", sa.Text()),
        sa.Column("poster_uploaded_at", sa.DateTime(timezone=True)),
        sa.Column("video_key", sa.Text()),
        sa.Column("video_uploaded_at", sa.DateTime(timezone=True)),
        sa.Column(
            "location",
            geoalchemy2.Geography(geometry_type="POINT", srid=4326, spatial_index=False),
        ),
        sa.Column("location_accuracy_m", sa.Numeric(8, 2)),
        sa.Column("location_label", sa.String(120)),
        sa.Column("location_source", sa.String(16)),
        sa.Column("location_set_at", sa.DateTime(timezone=True)),
        sa.Column(
            "location_set_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_video_analyses_created_at", "video_analyses", ["created_at"])
    # The map layer asks for located videos inside a viewport.
    op.create_index(
        "ix_video_analyses_location", "video_analyses", ["location"], postgresql_using="gist"
    )

    op.create_table(
        "video_analysis_potholes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "analysis_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("video_analyses.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("track_id", sa.String(64), nullable=False),
        sa.Column("first_seen_seconds", sa.Double(), nullable=False),
        sa.Column("last_seen_seconds", sa.Double(), nullable=False),
        sa.Column("best_frame_seconds", sa.Double()),
        sa.Column("confidence", sa.Double(), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("severity_score", sa.Double(), nullable=False),
        sa.Column("severity_confidence", sa.Double(), nullable=False),
        sa.Column("observation_count", sa.Integer(), nullable=False),
        sa.Column("max_area", sa.Double(), nullable=False),
        sa.Column("crop_key", sa.Text()),
        sa.Column("crop_uploaded_at", sa.DateTime(timezone=True)),
        sa.Column("full_key", sa.Text()),
        sa.Column("full_uploaded_at", sa.DateTime(timezone=True)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        # Upload targets and completion marks are addressed by track id, so it is unique
        # within an analysis. analysis_id leads, so this also serves "an analysis's potholes".
        sa.UniqueConstraint("analysis_id", "track_id", name="uq_video_analysis_potholes_track"),
    )


def downgrade() -> None:
    op.drop_table("video_analysis_potholes")
    op.drop_index("ix_video_analyses_location", table_name="video_analyses")
    op.drop_index("ix_video_analyses_created_at", table_name="video_analyses")
    op.drop_table("video_analyses")
