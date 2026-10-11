from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import (
    CitizenReportSource,
    CitizenReportState,
    PotholeStatus,
    SeverityLevel,
    UploadTarget,
)


class CitizenReportCreate(BaseModel):
    """A report submitted from the Mini App.

    No reporter identity here: it comes from the verified `initData` header, never from
    the body. A client that could name its own user could report as anyone.
    """

    client_report_id: uuid.UUID = Field(
        description="Client-generated, makes a retried submission idempotent"
    )
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    location_accuracy_m: float | None = Field(default=None, ge=0, le=10_000)
    comment: str | None = Field(default=None, max_length=500)


class CitizenReportAccepted(BaseModel):
    id: uuid.UUID
    pothole_id: uuid.UUID
    latitude: float
    longitude: float
    status: PotholeStatus
    created_pothole: bool
    deduplicated: bool
    already_reported: bool
    verified_now: bool
    distinct_reporters: int
    confirmations_required: int
    sighting_count: int
    image_upload: UploadTarget | None = None


class CitizenReportOut(BaseModel):
    """Operator-facing view. Carries the reporter, so it is never returned publicly."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    pothole_id: uuid.UUID | None
    source: CitizenReportSource
    latitude: float
    longitude: float
    location_accuracy_m: float
    reported_at: datetime
    comment: str | None
    image_url: str | None = None
    review_state: CitizenReportState
    review_note: str | None = None
    reviewed_at: datetime | None = None
    telegram_username: str | None = None
    pothole_status: PotholeStatus | None = None
    pothole_severity: SeverityLevel | None = None


class CitizenReportReview(BaseModel):
    state: CitizenReportState
    note: str | None = Field(default=None, max_length=500)
