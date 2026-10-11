"""Post-processing is verified against hand-built tensors.

No trained weights live in the repository, so synthetic detector outputs are the only
way to catch a transposed layout, a forgotten letterbox offset or a broken NMS - the
failures that silently move every box.
"""

from __future__ import annotations

import numpy as np
import pytest

from ai.inference.geometry import BoundingBox, iou
from ai.inference.postprocess import (
    compute_letterbox,
    decode_detections,
    input_box_to_normalised,
    non_maximum_suppression,
    resolve_layout,
)

TRANSFORM = compute_letterbox(1280, 720, 640, 640)


def channels_first(rows: list[list[float]], num_classes: int = 1) -> np.ndarray:
    return np.array(rows, dtype=np.float32).T[np.newaxis, ...]


def channels_last(rows: list[list[float]], num_classes: int = 1) -> np.ndarray:
    return np.array(rows, dtype=np.float32)[np.newaxis, ...]


def decode(
    output: np.ndarray,
    class_names=("pothole",),
    threshold: float = 0.5,
    max_detections: int = 10,
    layout="auto",
):
    return decode_detections(
        output,
        class_names,
        confidence_threshold=threshold,
        nms_iou_threshold=0.45,
        max_detections=max_detections,
        transform=TRANSFORM,
        layout=layout,
    )


class TestGeometry:
    def test_identical_boxes_fully_overlap(self):
        box = BoundingBox(0.1, 0.1, 0.2, 0.2)
        assert iou(box, box) == pytest.approx(1.0)

    def test_disjoint_boxes_do_not_overlap(self):
        assert iou(BoundingBox(0, 0, 0.1, 0.1), BoundingBox(0.5, 0.5, 0.1, 0.1)) == 0.0

    def test_partial_overlap(self):
        a = BoundingBox(0, 0, 0.2, 0.2)
        b = BoundingBox(0.1, 0.1, 0.2, 0.2)
        assert iou(a, b) == pytest.approx(0.01 / 0.07)

    def test_degenerate_boxes_do_not_divide_by_zero(self):
        assert iou(BoundingBox(0.1, 0.1, 0, 0), BoundingBox(0.1, 0.1, 0.2, 0.2)) == 0.0

    def test_clamping_keeps_the_visible_part(self):
        clamped = BoundingBox(0.9, -0.1, 0.4, 0.3).clamped()
        assert clamped.x == pytest.approx(0.9)
        assert clamped.y == 0.0
        assert clamped.width == pytest.approx(0.1)
        assert clamped.height == pytest.approx(0.2)

    def test_pixel_conversion_clips_to_the_frame(self):
        assert BoundingBox(0.5, 0.5, 0.25, 0.25).to_pixels(1280, 720) == (640, 360, 320, 180)
        assert BoundingBox(-0.1, 0.9, 0.3, 0.3).to_pixels(100, 100) == (0, 90, 20, 10)


class TestLetterbox:
    def test_pads_the_short_axis(self):
        assert TRANSFORM.scale == pytest.approx(0.5)
        assert TRANSFORM.pad_x == pytest.approx(0.0)
        assert TRANSFORM.pad_y == pytest.approx(140.0)

    def test_portrait_frames_pad_horizontally(self):
        transform = compute_letterbox(720, 1280, 640, 640)
        assert transform.pad_x == pytest.approx(140.0)
        assert transform.pad_y == pytest.approx(0.0)

    def test_maps_input_pixels_back_to_normalised_source(self):
        box = input_box_to_normalised(320, 320, 64, 32, TRANSFORM)
        assert box.x == pytest.approx(0.45)
        assert box.y == pytest.approx(328 / 720)
        assert box.width == pytest.approx(0.1)
        assert box.height == pytest.approx(64 / 720)

    def test_full_padded_image_maps_to_the_whole_frame(self):
        box = input_box_to_normalised(320, 320, 640, 360, TRANSFORM)
        assert (box.x, box.y) == pytest.approx((0.0, 0.0))
        assert (box.width, box.height) == pytest.approx((1.0, 1.0))

    def test_rejects_an_impossible_source_size(self):
        with pytest.raises(ValueError, match="Invalid source size"):
            compute_letterbox(0, 720, 640, 640)


class TestLayoutDetection:
    def test_detects_the_ultralytics_head(self):
        assert resolve_layout((1, 5, 8400), 1) == ("channels-first", 8400)

    def test_detects_a_transposed_head(self):
        assert resolve_layout((1, 8400, 5), 1) == ("channels-last", 8400)

    def test_prefers_the_default_when_ambiguous(self):
        assert resolve_layout((1, 5, 5), 1)[0] == "channels-first"

    def test_honours_an_explicit_layout(self):
        assert resolve_layout((1, 5, 5), 1, "channels-last")[0] == "channels-last"

    def test_rejects_an_unknown_shape(self):
        with pytest.raises(ValueError, match="no axis of size 5"):
            resolve_layout((1, 7, 9), 1)


class TestNonMaximumSuppression:
    def test_keeps_the_strongest_of_overlapping_boxes(self):
        a = (BoundingBox(0.4, 0.4, 0.2, 0.2), 0.9, 0)
        b = (BoundingBox(0.41, 0.41, 0.2, 0.2), 0.7, 0)
        kept = non_maximum_suppression([a, b], 0.45, 10)
        assert kept == [a]

    def test_keeps_separate_objects(self):
        a = (BoundingBox(0.1, 0.4, 0.1, 0.1), 0.9, 0)
        b = (BoundingBox(0.7, 0.4, 0.1, 0.1), 0.8, 0)
        assert len(non_maximum_suppression([a, b], 0.45, 10)) == 2

    def test_does_not_suppress_across_classes(self):
        a = (BoundingBox(0.4, 0.4, 0.2, 0.2), 0.9, 0)
        b = (BoundingBox(0.4, 0.4, 0.2, 0.2), 0.8, 1)
        assert len(non_maximum_suppression([a, b], 0.45, 10)) == 2


class TestDecode:
    def test_decodes_a_box_and_undoes_the_padding(self):
        detections = decode(channels_first([[320, 320, 64, 32, 0.9]]))
        assert len(detections) == 1
        assert detections[0].class_name == "pothole"
        assert detections[0].confidence == pytest.approx(0.9, abs=1e-6)
        assert detections[0].bbox.x == pytest.approx(0.45, abs=1e-6)

    def test_both_layouts_agree(self):
        rows = [[320, 320, 64, 32, 0.9], [500, 400, 40, 40, 0.7]]
        assert decode(channels_first(rows)) == decode(channels_last(rows))

    def test_drops_low_confidence_anchors(self):
        rows = [[320, 320, 64, 32, 0.9], [500, 400, 40, 40, 0.2]]
        assert len(decode(channels_first(rows))) == 1

    def test_suppresses_duplicates_of_one_object(self):
        rows = [
            [320, 320, 64, 32, 0.72],
            [322, 321, 66, 33, 0.94],
            [321, 319, 63, 31, 0.81],
        ]
        detections = decode(channels_first(rows))
        assert len(detections) == 1
        assert detections[0].confidence == pytest.approx(0.94, abs=1e-6)

    def test_honours_the_detection_limit(self):
        rows = [[40 + i * 45, 300, 30, 20, 0.9] for i in range(12)]
        assert len(decode(channels_first(rows), max_detections=4)) == 4

    def test_drops_classes_that_are_not_potholes(self):
        rows = [[320, 320, 64, 32, 0.9, 0.1], [500, 400, 40, 40, 0.1, 0.95]]
        detections = decode(channels_first(rows, 2), class_names=("pothole", "longitudinal_crack"))
        assert len(detections) == 1
        assert detections[0].class_id == 0

    def test_ignores_zero_area_anchors(self):
        assert decode(channels_first([[320, 320, 0, 0, 0.99]])) == []
