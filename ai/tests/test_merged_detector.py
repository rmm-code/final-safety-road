"""Several detectors run through the pipeline as one (`ai/evaluation/merged_detector.py`)."""

from __future__ import annotations

import pytest

from ai.evaluation.merged_detector import MergedDetector
from ai.inference.detector import DetectorInfo
from ai.inference.geometry import BoundingBox
from ai.inference.types import Detection


class _Fixed:
    """A detector that sees the same thing in every frame."""

    def __init__(
        self,
        version: str,
        detections: list[Detection],
        other: dict[str, int] | None = None,
        synthetic: bool = False,
    ) -> None:
        self._info = DetectorInfo(
            kind="onnx",
            model_version=version,
            backend="test",
            is_synthetic=synthetic,
            selection_reason="test",
        )
        self._detections = detections
        self._other = other or {}
        self.closed = False

    @property
    def info(self) -> DetectorInfo:
        return self._info

    @property
    def other_class_counts(self) -> dict[str, int]:
        return dict(self._other)

    def detect(self, frame: object) -> list[Detection]:
        return list(self._detections)

    def close(self) -> None:
        self.closed = True


def _pothole(x: float, y: float, confidence: float) -> Detection:
    return Detection(
        class_id=0, class_name="pothole", confidence=confidence, bbox=BoundingBox(x, y, 0.1, 0.1)
    )


def test_one_hole_seen_by_two_models_is_one_detection_at_the_higher_confidence() -> None:
    merged = MergedDetector(
        [_Fixed("a-1", [_pothole(0.10, 0.10, 0.40)]), _Fixed("b-1", [_pothole(0.11, 0.11, 0.70)])]
    )

    assert [d.confidence for d in merged.detect(None)] == [0.70]


def test_holes_only_one_model_sees_are_all_kept() -> None:
    merged = MergedDetector(
        [_Fixed("a-1", [_pothole(0.10, 0.10, 0.40)]), _Fixed("b-1", [_pothole(0.60, 0.60, 0.70)])]
    )

    assert [d.confidence for d in merged.detect(None)] == [0.70, 0.40]


def test_names_every_member_counts_their_other_classes_and_closes_them_all() -> None:
    a = _Fixed("a-1", [], other={"Crack": 2})
    b = _Fixed("b-1", [], other={"Crack": 1, "Speed-Bump": 3})
    merged = MergedDetector([a, b])

    assert merged.info.model_version == "a-1+b-1"
    assert merged.other_class_counts == {"Crack": 3, "Speed-Bump": 3}
    merged.close()
    assert a.closed and b.closed


def test_refuses_a_synthetic_member() -> None:
    # A merge that quietly included fabricated detections would score as a real model.
    with pytest.raises(ValueError, match="synthetic"):
        MergedDetector([_Fixed("a-1", []), _Fixed("mock-synthetic-0.1.0", [], synthetic=True)])
