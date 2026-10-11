"""Several detectors as one, so a merge can be run through the full product pipeline.

The union of every member's pothole detections, then non-maximum suppression across members
at the pooling IoU, keeping the most confident box. That is the rule `score_sets.py` scores a
merged detector by, so its frame-level and event-level numbers describe the same detector.
Evaluation only: the product runs one model.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from ai.evaluation.pool_review import CLUSTER_IOU
from ai.inference.detector import Detector, DetectorInfo
from ai.inference.geometry import iou
from ai.inference.types import Detection


class MergedDetector:
    def __init__(self, members: Sequence[Detector], iou_threshold: float = CLUSTER_IOU) -> None:
        if not members:
            raise ValueError("A merge needs at least one detector")
        synthetic = [m.info.model_version for m in members if m.info.is_synthetic]
        if synthetic:
            raise ValueError(f"A synthetic detector cannot be part of an evaluation: {synthetic}")
        self._members = list(members)
        self._iou = iou_threshold
        self._info = DetectorInfo(
            kind="merged",
            model_version="+".join(m.info.model_version for m in members),
            backend="+".join(sorted({m.info.backend for m in members})),
            is_synthetic=False,
            selection_reason=(
                f"Evaluation merge of {len(members)} detectors: union, then NMS at IoU "
                f"{iou_threshold} keeping the most confident box."
            ),
        )

    @property
    def info(self) -> DetectorInfo:
        return self._info

    @property
    def other_class_counts(self) -> dict[str, int]:
        totals: dict[str, int] = {}
        for member in self._members:
            for name, count in member.other_class_counts.items():
                totals[name] = totals.get(name, 0) + count
        return totals

    def detect(self, frame: np.ndarray) -> list[Detection]:
        pooled = sorted(
            (d for member in self._members for d in member.detect(frame)),
            key=lambda d: -d.confidence,
        )
        kept: list[Detection] = []
        for detection in pooled:
            if all(iou(detection.bbox, k.bbox) < self._iou for k in kept):
                kept.append(detection)
        return kept

    def close(self) -> None:
        for member in self._members:
            member.close()
