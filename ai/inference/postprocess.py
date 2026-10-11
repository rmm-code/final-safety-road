"""Letterboxing, output decoding and non-maximum suppression.

The assumed detector head is the Ultralytics YOLOv8/v11 detection output:
``[1, 4 + num_classes, num_anchors]`` with centre-form boxes in model-input pixels and
sigmoid-activated class scores (no separate objectness channel). A transposed head is
detected automatically. This mirrors ``packages/vision-web/src/postprocess``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np

from ai.inference.geometry import BoundingBox, iou
from ai.inference.types import Detection, is_pothole_class

OutputLayout = Literal["auto", "channels-first", "channels-last", "end-to-end"]

# Channel count of an end-to-end row: x1, y1, x2, y2, confidence, classId.
END_TO_END_CHANNELS = 6


@dataclass(frozen=True, slots=True)
class LetterboxTransform:
    """Aspect-preserving resize with centred padding."""

    source_width: int
    source_height: int
    input_width: int
    input_height: int
    scale: float
    pad_x: float
    pad_y: float


def compute_letterbox(
    source_width: int, source_height: int, input_width: int, input_height: int
) -> LetterboxTransform:
    if source_width <= 0 or source_height <= 0:
        raise ValueError(f"Invalid source size {source_width}x{source_height}")
    scale = min(input_width / source_width, input_height / source_height)
    return LetterboxTransform(
        source_width=source_width,
        source_height=source_height,
        input_width=input_width,
        input_height=input_height,
        scale=scale,
        pad_x=(input_width - source_width * scale) / 2,
        pad_y=(input_height - source_height * scale) / 2,
    )


def input_corners_to_normalised(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    transform: LetterboxTransform,
) -> BoundingBox:
    """Undo the letterbox for a corner-form box, as emitted by end-to-end heads."""
    left = (x1 - transform.pad_x) / transform.scale
    top = (y1 - transform.pad_y) / transform.scale
    right = (x2 - transform.pad_x) / transform.scale
    bottom = (y2 - transform.pad_y) / transform.scale
    return BoundingBox(
        x=left / transform.source_width,
        y=top / transform.source_height,
        width=(right - left) / transform.source_width,
        height=(bottom - top) / transform.source_height,
    ).clamped()


def input_box_to_normalised(
    centre_x: float,
    centre_y: float,
    width: float,
    height: float,
    transform: LetterboxTransform,
) -> BoundingBox:
    """Undo the letterbox and normalise against the source frame."""
    source_x = (centre_x - width / 2 - transform.pad_x) / transform.scale
    source_y = (centre_y - height / 2 - transform.pad_y) / transform.scale
    return BoundingBox(
        x=source_x / transform.source_width,
        y=source_y / transform.source_height,
        width=width / transform.scale / transform.source_width,
        height=height / transform.scale / transform.source_height,
    ).clamped()


def resolve_layout(
    dims: Sequence[int],
    num_classes: int,
    requested: OutputLayout = "auto",
    mask_coefficients: int = 0,
) -> tuple[str, int]:
    """Return (layout, num_anchors) for a raw output tensor shape."""
    if len(dims) != 3 or dims[0] != 1:
        raise ValueError(f"Unsupported detector output shape {list(dims)}; expected [1, a, b]")

    expected = 4 + num_classes + mask_coefficients
    axis1, axis2 = int(dims[1]), int(dims[2])

    if requested == "end-to-end":
        if axis2 != END_TO_END_CHANNELS:
            raise ValueError(
                f"Output shape {list(dims)} is not an end-to-end head; expected [1, n, 6]"
            )
        return "end-to-end", axis1
    if requested == "channels-first":
        if axis1 != expected:
            raise ValueError(
                f"Output shape {list(dims)} is not channels-first for {num_classes} class(es)"
            )
        return "channels-first", axis2
    if requested == "channels-last":
        if axis2 != expected:
            raise ValueError(
                f"Output shape {list(dims)} is not channels-last for {num_classes} class(es)"
            )
        return "channels-last", axis1

    if axis1 == expected:
        return "channels-first", axis2
    if axis2 == expected:
        return "channels-last", axis1
    if axis2 == END_TO_END_CHANNELS:
        return "end-to-end", axis1

    mask_note = f" + {mask_coefficients} mask coefficient(s)" if mask_coefficients else ""
    raise ValueError(
        f"Detector output {list(dims)} has no axis of size {expected} "
        f"(4 box values + {num_classes} class score(s){mask_note}). Declare the layout explicitly."
    )


def non_maximum_suppression(
    candidates: list[tuple[BoundingBox, float, int]],
    iou_threshold: float,
    max_output: int,
) -> list[tuple[BoundingBox, float, int]]:
    """Greedy NMS, applied per class."""
    kept: list[tuple[BoundingBox, float, int]] = []
    for box, score, class_id in sorted(candidates, key=lambda item: item[1], reverse=True):
        if len(kept) >= max_output:
            break
        if any(
            k_class == class_id and iou(k_box, box) > iou_threshold for k_box, _, k_class in kept
        ):
            continue
        kept.append((box, score, class_id))
    return kept


def decode_detections(
    output: np.ndarray,
    class_names: Sequence[str],
    confidence_threshold: float,
    nms_iou_threshold: float,
    max_detections: int,
    transform: LetterboxTransform,
    layout: OutputLayout = "auto",
    mask_coefficients: int = 0,
    on_skipped_class: Callable[[str], None] | None = None,
) -> list[Detection]:
    """Turn a raw detector tensor into normalised detections in our own schema."""
    num_classes = len(class_names)
    if num_classes == 0:
        raise ValueError("decode_detections requires at least one class name")

    resolved, num_anchors = resolve_layout(output.shape, num_classes, layout, mask_coefficients)

    if resolved == "end-to-end":
        kept = _decode_end_to_end(
            output[0], num_anchors, confidence_threshold, max_detections, transform
        )
    else:
        matrix = output[0] if resolved == "channels-first" else output[0].T
        kept = _decode_raw_head(
            matrix,
            num_anchors,
            num_classes,
            confidence_threshold,
            nms_iou_threshold,
            max_detections,
            transform,
        )

    # The product only carries potholes; any other class a multi-class model emits is
    # dropped here rather than leaking outward. Dropped classes are still counted, so an
    # operator can see what the detector recognised without it becoming an entity.
    detections: list[Detection] = []
    for box, score, class_id in kept:
        if not 0 <= class_id < num_classes:
            continue
        name = class_names[class_id]
        if not is_pothole_class(name):
            if on_skipped_class is not None:
                on_skipped_class(name)
            continue
        detections.append(
            Detection(class_id=class_id, class_name="pothole", confidence=score, bbox=box)
        )
    return detections


def _decode_raw_head(
    matrix: np.ndarray,
    num_anchors: int,
    num_classes: int,
    confidence_threshold: float,
    nms_iou_threshold: float,
    max_detections: int,
    transform: LetterboxTransform,
) -> list[tuple[BoundingBox, float, int]]:
    """Per-anchor class scores over centre-form boxes; needs NMS."""
    boxes = matrix[:4, :]
    # Only the class channels are read; mask coefficients that follow are skipped.
    scores = matrix[4 : 4 + num_classes, :]
    best_class = np.argmax(scores, axis=0)
    best_score = scores[best_class, np.arange(num_anchors)]

    candidates: list[tuple[BoundingBox, float, int]] = []
    for index in np.flatnonzero(best_score >= confidence_threshold):
        box = input_box_to_normalised(
            float(boxes[0, index]),
            float(boxes[1, index]),
            float(boxes[2, index]),
            float(boxes[3, index]),
            transform,
        )
        if box.area <= 0:
            continue
        candidates.append((box, float(best_score[index]), int(best_class[index])))

    return non_maximum_suppression(candidates, nms_iou_threshold, max_detections)


def _decode_end_to_end(
    rows: np.ndarray,
    num_rows: int,
    confidence_threshold: float,
    max_detections: int,
    transform: LetterboxTransform,
) -> list[tuple[BoundingBox, float, int]]:
    """NMS already ran inside the graph, so rows are final detections."""
    kept: list[tuple[BoundingBox, float, int]] = []
    for index in range(num_rows):
        if len(kept) >= max_detections:
            break
        score = float(rows[index, 4])
        if score < confidence_threshold:
            continue
        box = input_corners_to_normalised(
            float(rows[index, 0]),
            float(rows[index, 1]),
            float(rows[index, 2]),
            float(rows[index, 3]),
            transform,
        )
        if box.area <= 0:
            continue
        kept.append((box, score, int(round(float(rows[index, 5])))))
    return kept
