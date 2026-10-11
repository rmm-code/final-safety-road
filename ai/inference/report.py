"""Analysis report construction.

Emits the same schema as the web console
(``packages/shared-types/src/events.ts::VideoAnalysisReport``) so reports from the
browser and from this CLI are interchangeable.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from ai.inference.config import VisionConfig
from ai.inference.detector import DetectorInfo
from ai.inference.types import PotholeTrack, SeverityResult

LOCATION_UNAVAILABLE_REASON = (
    "Uploaded video files carry no GPS telemetry. Coordinates are recorded only for live "
    "drive sessions."
)


def track_summary(track: PotholeTrack, severity: SeverityResult) -> dict[str, Any]:
    best = track.best_frame
    return {
        "trackId": track.local_track_id,
        "firstSeenSeconds": round(track.first_seen_at / 1000, 3),
        "lastSeenSeconds": round(track.last_seen_at / 1000, 3),
        "maxConfidence": round(track.max_confidence, 4),
        "severity": severity.level,
        "severityScore": round(severity.score, 4),
        "severityConfidence": round(severity.confidence, 4),
        "observationCount": len(track.observations),
        "maxArea": round(track.max_area, 6),
        "bestFrameSeconds": None if best is None else round(best.timestamp_ms / 1000, 3),
    }


def build_report(
    *,
    source_name: str,
    duration_seconds: float,
    width: int,
    height: int,
    detector: DetectorInfo,
    config: VisionConfig,
    frames_analysed: int,
    raw_detections: int,
    rejected_tracks: int,
    other_classes: dict[str, int] | None = None,
    tracks: list[tuple[PotholeTrack, SeverityResult]],
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    counts = {"small": 0, "medium": 0, "large": 0, "unknown": 0}
    for _track, severity in tracks:
        counts[severity.level] += 1

    average_confidence = (
        sum(track.max_confidence for track, _ in tracks) / len(tracks) if tracks else 0.0
    )

    return {
        "schemaVersion": 1,
        "generatedAt": (generated_at or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
        "source": {
            "name": source_name,
            "durationSeconds": round(duration_seconds, 3),
            "width": width,
            "height": height,
        },
        "engine": {
            "kind": detector.kind,
            "modelVersion": detector.model_version,
            "backend": detector.backend,
            "isSynthetic": detector.is_synthetic,
            "selectionReason": detector.selection_reason,
        },
        "analysis": {
            "sampleFps": config.sample_fps,
            "framesAnalysed": frames_analysed,
            "confidenceThreshold": config.detection.confidence_threshold,
            "iouMatchThreshold": config.tracking.iou_match_threshold,
            "minObservations": config.tracking.min_observations,
            "rawDetections": raw_detections,
            "rejectedTracks": rejected_tracks,
            "otherClasses": dict(other_classes or {}),
        },
        # A video file carries no telemetry, and coordinates are never invented.
        "location": {"available": False, "reason": LOCATION_UNAVAILABLE_REASON},
        "summary": {
            "totalPotholes": len(tracks),
            "small": counts["small"],
            "medium": counts["medium"],
            "large": counts["large"],
            "unknown": counts["unknown"],
            "averageConfidence": round(average_confidence, 4),
        },
        "tracks": [track_summary(track, severity) for track, severity in tracks],
    }
