"""The four sample videos and the setup they are analysed with.

Mirrors apps/web/features/videos/lib/samples.ts (ids, titles, placement) and
SAMPLE_SETUP there; the dashboard finds each analysis by the same derived id.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ONNX = Path("apps/web/public/models")
# Our YOLO26m, trained 2026-10-11 on public data only (ai/yolo26/), so it never saw these
# four videos. Until then the samples ran the 3-model merge at 0.35 (current YOLOv8m +
# mfranzon YOLO26m + rezzzq YOLO12s); a tuple of several models is merged again.
MODELS = (ONNX / "candidates/yolo26m-public/pothole-yolo26m-public-0.1.0.onnx",)
THRESHOLD = 0.25
SAMPLE_FPS = 12.0
# A track is reported once its best detection reaches this (vision.yaml's minMaxConfidence,
# 0.55, was tuned on the YOLOv8m). Our YOLO26m scores real potholes lower, and at 0.55 it
# dropped holes the judges call real (video 1 kept 1 of them). Samples only: the live
# drive keeps vision.yaml. Not part of the analysis id, so a change means deleting the
# published analyses before publishing again.
CONFIRM_MIN_CONFIDENCE = 0.40
# Must equal SAMPLE_SETUP.modelVersion in apps/web/features/videos/lib/samples.ts: it is
# part of the analysis id, so publishing refuses an analysis made with any other model.
MODEL_VERSION = "pothole-yolo26m-public-0.1.0"


@dataclass(frozen=True)
class Sample:
    id: str
    title: str
    file: Path
    recorded_at: str | None
    location: dict | None = None


SAMPLES = (
    Sample("video-1", "Video 1", Path("samples/2026-05-25-10-12-58.mp4"), "2026-05-25T05:12:58Z"),
    Sample(
        "video-2",
        "Video 2",
        Path("samples/2026-05-24-16-53-36.mp4"),
        "2026-05-24T11:53:36Z",
        {
            "latitude": 41.32528,
            "longitude": 69.26345,
            "accuracyM": 100,
            "label": "Osiyo Grand, off Labzak street",
        },
    ),
    # The Tashkent streets clip (samples/2026-05-24-13-36-41.mp4) is no longer a sample: the
    # team shows it by uploading it in the Live demo instead. The broken-road clip, "Video 4"
    # in docs/model-comparison.md, took its place as Video 3 (2026-10-11).
    Sample(
        "video-3",
        "Video 3",
        Path("samples/AQM2jwkRRAWtNQQQbVwCZYSJVeIPSrBIr5QGDdjDdjJNWxcqEKshz2co_ddLrKl3P71IMsc.mp4"),
        None,
    ),
)
