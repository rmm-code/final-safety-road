from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import (
    DateTime,
    Double,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_column, uuid_pk

VIDEO_SOURCES = ("demo", "upload")


class VideoAnalysis(Base):
    """A road video analysed in a visitor's browser, saved so everyone can replay it.

    Deliberately NOT a source of sightings. A video file carries no GPS, so its position is
    whatever a person placed by hand, once, for the whole clip. Feeding that through dedup
    would merge every pothole in the clip into one and tighten its accuracy with each
    merge - fabricated precision on the map. Placing a video creates no `DetectionEvent`
    and no `Pothole`; the point lives here and only marks where the video was taken.

    Stored objects follow one rule: a `*_key` is set when an upload is offered, and
    `*_uploaded_at` only once the client reports it finished. Only an uploaded object is
    handed out as a URL, so an interrupted upload reads as "not stored", not as a broken
    player. Uploaded marks are never cleared.
    """

    __tablename__ = "video_analyses"

    # The client's own id, generated before the first attempt. As the primary key it is
    # what makes a retried create return the analysis instead of saving it twice.
    id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    file_name: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    # Demo clips are files the web app itself serves under /demo/; only their paths are
    # stored. An uploaded clip has storage keys instead.
    demo_video_path: Mapped[str | None] = mapped_column(Text)
    demo_poster_path: Mapped[str | None] = mapped_column(Text)
    video_content_type: Mapped[str | None] = mapped_column(String(64))
    recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_seconds: Mapped[float] = mapped_column(Double, nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)

    # How the analysis was made, so two analyses of one clip can be told apart.
    model_version: Mapped[str] = mapped_column(String(120), nullable=False)
    confidence_threshold: Mapped[float] = mapped_column(Double, nullable=False)
    sample_fps: Mapped[float] = mapped_column(Double, nullable=False)
    frames_analysed: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_detections: Mapped[int] = mapped_column(Integer, nullable=False)
    rejected_tracks: Mapped[int] = mapped_column(Integer, nullable=False)
    average_inference_ms: Mapped[float] = mapped_column(Double, nullable=False)

    overlay_key: Mapped[str | None] = mapped_column(Text)
    overlay_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    poster_key: Mapped[str | None] = mapped_column(Text)
    poster_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    video_key: Mapped[str | None] = mapped_column(Text)
    video_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Where the video was taken, placed by hand. Null until someone places it. The source
    # is stored with it, as for sightings, so a hand-placed point never passes for a fix.
    # `spatial_index=False` because the explicit index below is the one we want: the
    # default would add a second, identical GiST index (as it did on `potholes`).
    location: Mapped[object | None] = mapped_column(
        Geography(geometry_type="POINT", srid=4326, spatial_index=False)
    )
    location_accuracy_m: Mapped[float | None] = mapped_column(Numeric(8, 2))
    location_label: Mapped[str | None] = mapped_column(String(120))
    location_source: Mapped[str | None] = mapped_column(String(16))
    location_set_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    location_set_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    created_at: Mapped[datetime] = created_at_column()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    __table_args__ = (
        # The map asks for located videos inside a viewport.
        Index("ix_video_analyses_location", "location", postgresql_using="gist"),
        # Every list is newest first.
        Index("ix_video_analyses_created_at", "created_at"),
    )


class VideoAnalysisPothole(Base):
    """One pothole track found in a saved video analysis.

    Neither a `Pothole` nor a `DetectionEvent`: it has a time in the clip, not a position
    on the road, and it never reaches dedup or the pothole map. It is what the replay page
    and the Potholes gallery show for this video.
    """

    __tablename__ = "video_analysis_potholes"

    id: Mapped[uuid.UUID] = uuid_pk()
    analysis_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("video_analyses.id", ondelete="CASCADE"), nullable=False
    )
    # The browser's local track id. Unique within one analysis, because upload targets
    # and completion marks are addressed by it.
    track_id: Mapped[str] = mapped_column(String(64), nullable=False)
    first_seen_seconds: Mapped[float] = mapped_column(Double, nullable=False)
    last_seen_seconds: Mapped[float] = mapped_column(Double, nullable=False)
    best_frame_seconds: Mapped[float | None] = mapped_column(Double)
    confidence: Mapped[float] = mapped_column(Double, nullable=False)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    severity_score: Mapped[float] = mapped_column(Double, nullable=False)
    severity_confidence: Mapped[float] = mapped_column(Double, nullable=False)
    observation_count: Mapped[int] = mapped_column(Integer, nullable=False)
    max_area: Mapped[float] = mapped_column(Double, nullable=False)

    crop_key: Mapped[str | None] = mapped_column(Text)
    crop_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    full_key: Mapped[str | None] = mapped_column(Text)
    full_uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_column()

    __table_args__ = (
        # Also the index for "this analysis's potholes": analysis_id leads it.
        UniqueConstraint("analysis_id", "track_id", name="uq_video_analysis_potholes_track"),
    )
