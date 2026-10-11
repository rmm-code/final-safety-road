"""Saved video analyses on the wire.

camelCase both ways, like the detections request: every model here takes an alias
generator, and FastAPI serialises responses by alias. The one exception is
`UploadTarget`, which keeps the snake_case shape the web already parses for evidence
photos (`expires_in_seconds`).

Requests forbid unknown fields, as `DetectionEventCreate` does: a misspelt optional field
must fail loudly rather than be dropped and stored as null.
"""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic.alias_generators import to_camel

from app.schemas.common import LocationSource, SeverityLevel, UploadTarget
from app.schemas.detection import SYNTHETIC_MODEL_PREFIX

VideoSource = Literal["demo", "upload"]
VideoContentType = Literal["video/mp4", "video/webm", "video/quicktime"]

MAX_POTHOLES_PER_ANALYSIS = 500
INT32_MAX = 2_147_483_647

# A demo clip is a file the web app serves from its own `public/demo/`. Only plain file
# paths under that prefix are stored: no scheme, no host, no `..` (literal or encoded),
# because the path is put straight into a <video src> on the site's own origin.
DEMO_PREFIX = "/demo/"
_DEMO_PATH = re.compile(r"/demo/[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*")

TrackId = Annotated[str, StringConstraints(min_length=1, max_length=64)]


def _camel(**extra) -> ConfigDict:
    return ConfigDict(alias_generator=to_camel, populate_by_name=True, **extra)


def _request() -> ConfigDict:
    # Unknown fields refused, and no NaN or Infinity: Python's JSON parser accepts both,
    # and an infinite duration would serialise back to the client as null.
    return _camel(extra="forbid", allow_inf_nan=False)


def _demo_path(value: str | None, field: str) -> str | None:
    if value is None:
        return None
    if not _DEMO_PATH.fullmatch(value) or ".." in value.split("/"):
        raise ValueError(f"{field} must be the path of a file under {DEMO_PREFIX}")
    return value


class VideoPotholeIn(BaseModel):
    """One pothole track, as the browser's analysis report describes it."""

    model_config = _request()

    track_id: TrackId
    first_seen_seconds: float = Field(ge=0)
    last_seen_seconds: float = Field(ge=0)
    best_frame_seconds: float | None = Field(default=None, ge=0)
    confidence: float = Field(ge=0, le=1)
    severity: SeverityLevel
    severity_score: float = Field(ge=0, le=1)
    severity_confidence: float = Field(ge=0, le=1)
    observation_count: int = Field(ge=0, le=INT32_MAX)
    max_area: float = Field(ge=0)
    # Whether the browser holds a crop / a full frame to upload. Upload targets are
    # offered only where it does.
    has_crop: bool
    has_full: bool

    @model_validator(mode="after")
    def _ends_after_it_starts(self) -> VideoPotholeIn:
        if self.last_seen_seconds < self.first_seen_seconds:
            raise ValueError("lastSeenSeconds is before firstSeenSeconds")
        return self


class VideoAnalysisCreate(BaseModel):
    """A finished browser analysis, saved under the client's own id."""

    model_config = _request()

    id: uuid.UUID
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    file_name: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    source: VideoSource
    # Demo only, and required there: the file the web app serves.
    video_url: str | None = Field(default=None, max_length=500)
    # Demo only, optional.
    poster_url: str | None = Field(default=None, max_length=500)
    # Upload only. Null on an upload means the video itself will not be stored (too large,
    # say): the analysis is saved and the replay page says so.
    video_content_type: VideoContentType | None = None
    recorded_at: datetime | None = None
    duration_seconds: float = Field(gt=0)
    width: int = Field(gt=0, le=INT32_MAX)
    height: int = Field(gt=0, le=INT32_MAX)
    model_version: str = Field(min_length=1, max_length=120)
    confidence_threshold: float = Field(ge=0, le=1)
    sample_fps: float = Field(gt=0)
    frames_analysed: int = Field(ge=0, le=INT32_MAX)
    raw_detections: int = Field(ge=0, le=INT32_MAX)
    rejected_tracks: int = Field(ge=0, le=INT32_MAX)
    average_inference_ms: float = Field(ge=0)
    potholes: list[VideoPotholeIn] = Field(
        default_factory=list, max_length=MAX_POTHOLES_PER_ANALYSIS
    )

    @field_validator("model_version")
    @classmethod
    def _not_synthetic(cls, value: str) -> str:
        # Same rule, same prefix as detections: the mock engine's boxes are fabricated,
        # and a saved analysis is shown to everyone as a real result.
        if value.startswith(SYNTHETIC_MODEL_PREFIX):
            raise ValueError("synthetic analyses are never accepted")
        return value

    @field_validator("recorded_at")
    @classmethod
    def _as_utc(cls, value: datetime | None) -> datetime | None:
        if value is None or value.tzinfo is not None:
            return value
        return value.replace(tzinfo=UTC)

    @model_validator(mode="after")
    def _source_rules(self) -> VideoAnalysisCreate:
        if self.source == "demo":
            if self.video_url is None:
                raise ValueError("a demo analysis needs videoUrl")
            _demo_path(self.video_url, "videoUrl")
            _demo_path(self.poster_url, "posterUrl")
            if self.video_content_type is not None:
                raise ValueError("videoContentType is for uploaded videos only")
        else:
            if self.video_url is not None:
                raise ValueError("an uploaded video is stored by the API; videoUrl is demo only")
            if self.poster_url is not None:
                raise ValueError("an uploaded video's poster is uploaded; posterUrl is demo only")

        track_ids = [item.track_id for item in self.potholes]
        if len(set(track_ids)) != len(track_ids):
            raise ValueError("trackId must be unique within an analysis")
        return self


class VideoAnalysisComplete(BaseModel):
    """Which uploads the client finished. True or listed means uploaded; never un-marks."""

    model_config = _request()

    overlay: bool = False
    poster: bool = False
    video: bool = False
    crops: list[TrackId] = Field(default_factory=list, max_length=MAX_POTHOLES_PER_ANALYSIS)
    fulls: list[TrackId] = Field(default_factory=list, max_length=MAX_POTHOLES_PER_ANALYSIS)


class VideoLocationIn(BaseModel):
    """A point placed by hand. Its source is always "manual"; the client cannot choose."""

    model_config = _request()

    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    # A pin for a whole clip is never good to better than a metre, and the upper bound
    # keeps a typo from claiming a point for half a country.
    accuracy_m: float = Field(ge=1, le=5000)
    label: Annotated[str, StringConstraints(strip_whitespace=True, max_length=120)] | None = None

    @field_validator("label")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        return value or None


# --- Responses ------------------------------------------------------------------------


class SeverityCounts(BaseModel):
    small: int = 0
    medium: int = 0
    large: int = 0
    unknown: int = 0


class VideoLocationOut(BaseModel):
    model_config = _camel()

    latitude: float
    longitude: float
    accuracy_m: float
    label: str | None
    # Not in the original contract: a hand-placed point is labelled wherever it is shown,
    # as a sighting's is. Always "manual" today.
    source: LocationSource


class VideoAnalysisSummary(BaseModel):
    model_config = _camel()

    id: uuid.UUID
    title: str
    file_name: str
    source: VideoSource
    created_at: datetime
    recorded_at: datetime | None
    duration_seconds: float
    # Demo: the stored /demo/ path. Upload: a signed link once uploaded. Otherwise null.
    poster_url: str | None
    pothole_count: int
    severity_counts: SeverityCounts
    location: VideoLocationOut | None
    model_version: str
    confidence_threshold: float


class VideoPotholeOut(BaseModel):
    model_config = _camel()

    id: uuid.UUID
    track_id: str
    first_seen_seconds: float
    last_seen_seconds: float
    best_frame_seconds: float | None
    confidence: float
    severity: SeverityLevel
    severity_score: float
    severity_confidence: float
    observation_count: int
    max_area: float
    # Signed links, only once the image is marked uploaded.
    crop_url: str | None
    full_url: str | None


class VideoAnalysisDetail(VideoAnalysisSummary):
    # Demo: the stored /demo/ path. Upload: a signed link once the upload is marked, so a
    # failed upload reads as "video not stored" rather than a broken player.
    video_url: str | None
    overlay_url: str | None
    width: int
    height: int
    sample_fps: float
    frames_analysed: int
    raw_detections: int
    rejected_tracks: int
    average_inference_ms: float
    potholes: list[VideoPotholeOut]


class VideoPotholeUploads(BaseModel):
    crop: UploadTarget | None = None
    full: UploadTarget | None = None


class VideoAnalysisUploads(BaseModel):
    """A target for every object not yet marked uploaded; null for the rest.

    `potholes` has an entry for every track of the analysis, keyed by track id.
    """

    overlay: UploadTarget | None = None
    poster: UploadTarget | None = None
    video: UploadTarget | None = None
    potholes: dict[str, VideoPotholeUploads] = Field(default_factory=dict)


class VideoAnalysisCreated(BaseModel):
    model_config = _camel()

    analysis: VideoAnalysisDetail
    uploads: VideoAnalysisUploads


class VideoAnalysisList(BaseModel):
    items: list[VideoAnalysisSummary]


class LocatedVideoAnalysis(BaseModel):
    """One marker on the map: a placed video and a few of its pothole crops."""

    model_config = _camel()

    id: uuid.UUID
    title: str
    latitude: float
    longitude: float
    accuracy_m: float
    label: str | None
    pothole_count: int
    poster_url: str | None
    thumbnails: list[str]


class LocatedVideoAnalysisList(BaseModel):
    items: list[LocatedVideoAnalysis]


class VideoPotholeGalleryItem(VideoPotholeOut):
    analysis_id: uuid.UUID
    analysis_title: str
    located: bool


class VideoPotholeGallery(BaseModel):
    items: list[VideoPotholeGalleryItem]
    total: int
