"""Normalised detection and track types, mirroring packages/shared-types."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from ai.inference.geometry import BoundingBox

SeverityLevel = Literal["small", "medium", "large", "unknown"]

TrackState = Literal[
    "CANDIDATE",
    "TRACKING",
    "CONFIRMED",
    "FINALIZED",
    "REJECTED_LOW_CONFIDENCE",
]


@dataclass(frozen=True, slots=True)
class Detection:
    """Detector output, normalised into our own schema.

    Nothing downstream depends on a model's native output layout.
    """

    class_id: int
    class_name: str
    confidence: float
    bbox: BoundingBox
    # Instance-segmentation contour in normalised coordinates, when the model produces
    # one. A mask describes the visible pothole far better than its bounding box, which
    # matters because severity is driven by visible area.
    polygon: list[tuple[float, float]] | None = None


@dataclass(frozen=True, slots=True)
class DetectionObservation:
    timestamp_ms: float
    frame_index: int
    detection: Detection
    area: float
    in_trigger_region: bool


@dataclass(slots=True)
class CapturedFrame:
    """Best evidence frame retained for a track."""

    timestamp_ms: float
    frame_index: int
    score: float
    confidence: float
    bbox: BoundingBox
    crop_path: str | None = None


@dataclass(slots=True)
class PotholeTrack:
    local_track_id: str
    state: TrackState
    first_seen_at: float
    last_seen_at: float
    max_confidence: float
    max_area: float
    observations: list[DetectionObservation] = field(default_factory=list)
    missed_frames: int = 0
    best_frame: CapturedFrame | None = None
    finalized: bool = False


@dataclass(frozen=True, slots=True)
class SeverityResult:
    level: SeverityLevel
    score: float
    confidence: float
    rationale: str


# Class names that mean "pothole" across the public checkpoints worth deploying.
#
# "d40" is the RDD2022 label; road-anomaly datasets often capitalise it. Matching is
# case-insensitive and by NAME, never by index - a multi-class checkpoint may put
# potholes at any position, and matching by index would report cracks or speed bumps
# as potholes.
#
# Mirrored in packages/vision-web/src/postprocess/decode.ts.
POTHOLE_CLASS_ALIASES = frozenset({"pothole", "potholes", "d40"})


def is_pothole_class(name: str | None) -> bool:
    return name is not None and name.strip().lower() in POTHOLE_CLASS_ALIASES
