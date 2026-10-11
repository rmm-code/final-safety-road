from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_column, uuid_pk

POTHOLE_STATUSES = (
    # Reported by a member of the public and not yet corroborated. Everything else in
    # this tuple has been established either by our own detector or by an operator.
    "reported",
    "active",
    "suspected_repaired",
    "repaired",
    "false_positive",
    "ignored",
    "archived",
)


class Pothole(Base):
    """A physical defect in the road.

    Distinct from a sighting: many `DetectionEvent` rows may point at one of these. The
    location is the running estimate from every sighting merged into it, which is why it
    keeps its own accuracy figure rather than borrowing one event's.
    """

    __tablename__ = "potholes"

    id: Mapped[uuid.UUID] = uuid_pk()
    # Geography rather than Geometry: distances come out in metres on the sphere, which
    # is what every query here actually wants.
    location: Mapped[object] = mapped_column(
        Geography(geometry_type="POINT", srid=4326), nullable=False
    )
    location_accuracy_m: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    severity_score: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False, default=0)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active", index=True)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    sighting_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    primary_image_key: Mapped[str | None] = mapped_column(Text)
    road_name: Mapped[str | None] = mapped_column(Text)
    road_segment_id: Mapped[str | None] = mapped_column(Text)
    # An operator's verdict on the detector: "correct" or "false_positive". Not a status -
    # a correct pothole can still be repaired later - and not a history row, because
    # confirming changes nothing. See migration 0003.
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    review_verdict: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = created_at_column()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        # Every map view and every dedup lookup is a spatial query; without this index
        # they degrade to a full scan as soon as the table is real.
        Index("ix_potholes_location", "location", postgresql_using="gist"),
        Index("ix_potholes_status_last_seen", "status", "last_seen_at"),
        Index(
            "ix_potholes_unreviewed",
            "last_seen_at",
            postgresql_where=text("reviewed_at IS NULL"),
        ),
    )
