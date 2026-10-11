"""Best-frame selection for a pothole track.

Mirrors ``packages/vision-web/src/pipeline/best-frame-selector.ts``. The first frame of a
track is usually the worst one: the pothole is far away, small and often clipped by the
frame edge. Candidates are scored as a weighted product of detector confidence, visible
area, sharpness and distance from the edge, and only the winner is written to disk.
"""

from __future__ import annotations

import numpy as np

from ai.inference.config import VisionConfig
from ai.inference.geometry import BoundingBox
from ai.inference.severity import area_score, centrality_score, clamp01
from ai.inference.types import CapturedFrame


def laplacian_variance(crop: np.ndarray) -> float:
    """Variance of the Laplacian: the standard cheap sharpness measure."""
    import cv2

    if crop.size == 0 or crop.shape[0] < 3 or crop.shape[1] < 3:
        return 0.0
    grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def sharpness_score(variance: float, half_saturation: float) -> float:
    """Bound the variance to 0..1 so "sharp enough" frames are not endlessly outbid."""
    if half_saturation <= 0:
        return 1.0
    return clamp01(variance / (variance + half_saturation))


class BestFrameSelector:
    def __init__(self, config: VisionConfig) -> None:
        self._config = config
        self._best: dict[str, CapturedFrame] = {}

    def score(self, confidence: float, bbox: BoundingBox, sharpness: float | None = None) -> float:
        """Weighted product of the quality terms. Higher is better; always > 0."""
        best_frame = self._config.best_frame
        weights = best_frame.weights

        confidence_term = max(confidence, 1e-6)
        area_term = max(area_score(bbox.area, self._config.severity.area_score_reference), 1e-6)
        # An unavailable sharpness contributes a neutral 1.0 rather than reading as blur.
        sharpness_term = max(sharpness if sharpness is not None else 1.0, 1e-6)
        centrality_term = max(
            centrality_score(bbox, best_frame.edge_margin, best_frame.edge_clip_penalty), 1e-6
        )

        return (
            confidence_term**weights.confidence
            * area_term**weights.area
            * sharpness_term**weights.sharpness
            * centrality_term**weights.centrality
        )

    def would_accept(self, track_id: str, score: float) -> bool:
        current = self._best.get(track_id)
        return current is None or score > current.score

    def commit(self, track_id: str, frame: CapturedFrame) -> None:
        current = self._best.get(track_id)
        if current is not None and current.score >= frame.score:
            return
        self._best[track_id] = frame

    def peek(self, track_id: str) -> CapturedFrame | None:
        return self._best.get(track_id)

    def take(self, track_id: str) -> CapturedFrame | None:
        return self._best.pop(track_id, None)

    def discard(self, track_id: str) -> None:
        self._best.pop(track_id, None)
