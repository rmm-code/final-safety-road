from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import LocationSource, SeverityLevel, UploadTarget

# Synthetic engines version their output "mock-..." (browser and Python CLI alike). Their
# boxes are fabricated, and accepting one would put a fake sighting at a real position.
SYNTHETIC_MODEL_PREFIX = "mock-"


class DetectionEventCreate(BaseModel):
    """A sighting uploaded by a phone.

    Bounds are enforced here rather than trusted: a client is not a trusted source, and a
    latitude of 500 or a negative accuracy would corrupt every spatial query that follows.
    """

    client_event_id: uuid.UUID = Field(alias="clientEventId")
    drive_session_id: uuid.UUID = Field(alias="driveSessionId")
    detected_at: datetime = Field(alias="detectedAt")
    confidence: float = Field(ge=0, le=1)
    severity: SeverityLevel
    severity_score: float = Field(alias="severityScore", ge=0, le=1)
    severity_confidence: float | None = Field(default=None, alias="severityConfidence", ge=0, le=1)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    location_accuracy_m: float = Field(alias="locationAccuracyM", ge=0, le=10_000)
    # Absent means GPS: every phone in the field uploads without it. "manual" is a point an
    # operator placed by hand, and it is stored and shown as exactly that.
    location_source: LocationSource = Field(default="gps", alias="locationSource")
    heading_deg: float | None = Field(default=None, alias="headingDeg", ge=0, lt=360)
    speed_mps: float | None = Field(default=None, alias="speedMps", ge=0, le=200)
    model_version: str = Field(alias="modelVersion", min_length=1, max_length=120)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    @field_validator("model_version")
    @classmethod
    def _not_synthetic(cls, value: str) -> str:
        if value.startswith(SYNTHETIC_MODEL_PREFIX):
            raise ValueError("synthetic detections are never accepted")
        return value


class DetectionEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    client_event_id: uuid.UUID
    pothole_id: uuid.UUID | None
    drive_session_id: uuid.UUID
    detected_at: datetime
    confidence: float
    severity: SeverityLevel
    severity_score: float
    latitude: float
    longitude: float
    location_accuracy_m: float
    # No default on the way out: a sighting returned without its source must fail loudly,
    # never come back labelled GPS by omission.
    location_source: LocationSource
    model_version: str


class DetectionEventAccepted(BaseModel):
    """Result of ingesting a sighting.

    `deduplicated` says whether it joined an existing pothole rather than creating one -
    the client should never assume one upload means one new defect.
    """

    event: DetectionEventOut
    pothole_id: uuid.UUID
    deduplicated: bool
    created_pothole: bool
    already_ingested: bool
    full_image_upload: UploadTarget | None = None
    crop_image_upload: UploadTarget | None = None
