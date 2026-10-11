from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from geoalchemy2 import Geography
from sqlalchemy import DateTime, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_column, uuid_pk

# Where a sighting's coordinates came from. "gps" is the phone's own fix; "manual" is a
# point an operator placed on the map, because a video file carries no telemetry.
LOCATION_SOURCES = ("gps", "manual")


class DetectionEvent(Base):
    """One sighting of a pothole by one vehicle at one moment.

    Sightings are never deleted when they merge into a pothole: the history is what makes
    it possible to explain later why a pothole is on the map, and it is the raw material
    for retraining.
    """

    __tablename__ = "detection_events"

    id: Mapped[uuid.UUID] = uuid_pk()
    pothole_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("potholes.id", ondelete="SET NULL"), index=True
    )
    drive_session_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("drive_sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Generated on the phone before the upload is attempted. The unique constraint is what
    # makes retries after an ambiguous network failure safe.
    client_event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), unique=True, nullable=False, index=True
    )
    location: Mapped[object] = mapped_column(
        Geography(geometry_type="POINT", srid=4326), nullable=False
    )
    location_accuracy_m: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
    # A hand-placed point must never pass for a GPS fix. The server default is what labels
    # every sighting recorded before the column existed: all of them came from a phone.
    location_source: Mapped[str] = mapped_column(
        String(16), nullable=False, default="gps", server_default="gps"
    )
    detected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    confidence: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    severity_score: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False)
    severity_confidence: Mapped[float | None] = mapped_column(Numeric(6, 4))
    heading_deg: Mapped[float | None] = mapped_column(Numeric(6, 2))
    speed_mps: Mapped[float | None] = mapped_column(Numeric(7, 3))
    model_version: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    full_image_key: Mapped[str | None] = mapped_column(Text)
    crop_image_key: Mapped[str | None] = mapped_column(Text)
    event_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = created_at_column()

    __table_args__ = (Index("ix_detection_events_location", "location", postgresql_using="gist"),)
