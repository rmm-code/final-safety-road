"""Visual severity for a finalised track.

Mirrors ``packages/vision-web/src/pipeline/severity-engine.ts``. Severity is deliberately
not a detector class, so it can be retuned - or later upgraded with depth estimation and
IMU shock - without retraining the detector. Nothing here claims physical width, length
or depth: a single uncalibrated camera cannot measure them.
"""

from __future__ import annotations

import math

from ai.inference.config import VisionConfig
from ai.inference.geometry import BoundingBox
from ai.inference.types import PotholeTrack, SeverityLevel, SeverityResult


def clamp01(value: float) -> float:
    if math.isnan(value):
        return 0.0
    return min(1.0, max(0.0, value))


def area_score(area: float, reference: float) -> float:
    """Map a normalised area onto 0..1.

    A square-root curve keeps the small end discriminative: potholes occupy a small
    fraction of the frame, and a linear map would compress every small and medium defect
    into the bottom few percent.
    """
    if reference <= 0:
        return 0.0
    return clamp01(math.sqrt(max(0.0, area) / reference))


def centrality_score(box: BoundingBox, edge_margin: float, edge_clip_penalty: float) -> float:
    """Penalise boxes touching a frame edge: part of the pothole is out of view."""
    if edge_margin <= 0:
        return 1.0
    nearest = min(box.x, box.y, 1 - (box.x + box.width), 1 - (box.y + box.height))
    openness = clamp01(nearest / edge_margin)
    return edge_clip_penalty + (1 - edge_clip_penalty) * openness


class VisualSeverityEngine:
    def __init__(self, config: VisionConfig) -> None:
        self._config = config

    def calculate(self, track: PotholeTrack) -> SeverityResult:
        severity = self._config.severity

        if not track.observations:
            return SeverityResult("unknown", 0.0, 0.0, "No observations recorded for this track.")

        # Prefer observations from the trigger region: a pothole close to the vehicle
        # fills a predictable share of the frame, whereas a distant one looks tiny
        # regardless of how bad it is.
        trigger_observations = [o for o in track.observations if o.in_trigger_region]
        measured = trigger_observations or track.observations
        peak_area = max(o.area for o in measured)

        if peak_area <= 0:
            return SeverityResult("unknown", 0.0, 0.0, "Track has no positive visible area.")

        score = area_score(peak_area, severity.area_score_reference)
        level = self._level_for(score)

        weights = severity.confidence_weights
        persistence = clamp01(len(track.observations) / severity.persistence_reference_observations)
        confidence = clamp01(
            weights.base
            + weights.detection * clamp01(track.max_confidence)
            + weights.persistence * persistence
            + weights.trigger_region * (1.0 if trigger_observations else 0.0)
        )

        measured_in = "trigger region" if trigger_observations else "full frame"
        rationale = (
            f"Peak visible area {peak_area * 100:.2f}% of frame "
            f"(measured in {measured_in}, reference {severity.area_score_reference * 100:.1f}%), "
            f"{len(track.observations)} observation(s), peak detector confidence "
            f"{track.max_confidence * 100:.0f}%."
        )
        if len(track.observations) < self._config.tracking.min_observations:
            rationale += " Fewer observations than the confirmation minimum."

        return SeverityResult(level, score, confidence, rationale)

    def _level_for(self, score: float) -> SeverityLevel:
        if score <= self._config.severity.small_max:
            return "small"
        if score <= self._config.severity.medium_max:
            return "medium"
        return "large"
