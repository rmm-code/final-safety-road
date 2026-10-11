"""Drawing detections onto video frames."""

from __future__ import annotations

import numpy as np

from ai.inference.types import Detection

# BGR. Green marks a confirmed pothole - the same signal the web overlay gives - while
# the severity travels in the label text. Detections the pipeline did not confirm stay
# muted so the two are never confused.
DETECTION_COLOUR = (122, 169, 63)
UNTRACKED_COLOUR = (137, 113, 93)
TRIGGER_COLOUR = (36, 165, 245)


def draw_trigger_region(frame: np.ndarray, top_y: float) -> None:
    """Dashed line marking where a tracked pothole is close enough to locate."""
    import cv2

    height, width = frame.shape[:2]
    y = int(top_y * height)
    for x in range(0, width, 24):
        cv2.line(frame, (x, y), (min(x + 12, width), y), TRIGGER_COLOUR, 1)
    cv2.putText(
        frame,
        "TRIGGER REGION",
        (8, y - 6),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.4,
        TRIGGER_COLOUR,
        1,
        cv2.LINE_AA,
    )


def draw_detection(
    frame: np.ndarray,
    detection: Detection,
    label: str,
    colour: tuple[int, int, int],
    tracked: bool,
) -> None:
    import cv2

    height, width = frame.shape[:2]
    x, y, box_width, box_height = detection.bbox.to_pixels(width, height)
    if box_width <= 0 or box_height <= 0:
        return

    thickness = 2 if tracked else 1
    cv2.rectangle(frame, (x, y), (x + box_width, y + box_height), colour, thickness)

    font_scale = 0.42
    (text_width, text_height), baseline = cv2.getTextSize(
        label, cv2.FONT_HERSHEY_SIMPLEX, font_scale, 1
    )
    label_height = text_height + baseline + 4
    # Keep the label inside the frame when the box sits at the very top.
    label_y = y - label_height if y - label_height >= 0 else y + box_height

    cv2.rectangle(frame, (x, label_y), (x + text_width + 8, label_y + label_height), colour, -1)
    cv2.putText(
        frame,
        label,
        (x + 4, label_y + text_height + 2),
        cv2.FONT_HERSHEY_SIMPLEX,
        font_scale,
        (11, 16, 7),
        1,
        cv2.LINE_AA,
    )


def draw_banner(frame: np.ndarray, text: str) -> None:
    """Persistent notice, used to mark synthetic output on every rendered frame."""
    import cv2

    width = frame.shape[1]
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (width, 26), (18, 12, 8), -1)
    cv2.addWeighted(overlay, 0.75, frame, 0.25, 0, frame)
    cv2.putText(
        frame, text, (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (36, 165, 245), 1, cv2.LINE_AA
    )
