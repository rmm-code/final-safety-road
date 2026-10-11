from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import LocationSource, PotholeStatus, SeverityLevel

ReviewVerdict = Literal["correct", "false_positive"]


class PotholeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    latitude: float
    longitude: float
    location_accuracy_m: float
    severity: SeverityLevel
    severity_score: float
    status: PotholeStatus
    first_seen_at: datetime
    last_seen_at: datetime
    sighting_count: int
    primary_image_key: str | None = None
    road_name: str | None = None
    reviewed_at: datetime | None = None
    review_verdict: ReviewVerdict | None = None


class PotholeObservation(BaseModel):
    id: uuid.UUID
    detected_at: datetime
    confidence: float
    severity: SeverityLevel
    model_version: str
    # A GPS sighting shows its fix's accuracy; a hand-placed one must say it was placed by
    # hand instead. Both required, so neither can go missing silently.
    location_accuracy_m: float
    location_source: LocationSource
    crop_image_key: str | None = None
    full_image_key: str | None = None
    # Short-lived signed links, so the console can show evidence it cannot list.
    crop_image_url: str | None = None
    full_image_url: str | None = None


class PotholeDetail(PotholeOut):
    primary_image_url: str | None = None
    observations: list[PotholeObservation] = Field(default_factory=list)


class PotholeReview(BaseModel):
    """An operator's verdict on what the detector reported."""

    verdict: ReviewVerdict
    note: str | None = Field(default=None, max_length=500)


class PotholeStatusUpdate(BaseModel):
    status: PotholeStatus
    reason: str | None = Field(default=None, max_length=500)


class PotholePatch(BaseModel):
    road_name: str | None = Field(default=None, max_length=300)
    road_segment_id: str | None = Field(default=None, max_length=120)


class StatsOverview(BaseModel):
    active_potholes: int
    large: int
    medium: int
    small: int
    new_today: int
    sightings_today: int
    drive_sessions: int
    total_sightings: int
