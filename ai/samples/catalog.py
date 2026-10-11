"""The four sample videos and the setup they are analysed with.

Mirrors apps/web/features/videos/lib/samples.ts (ids, titles, placement) and
SAMPLE_SETUP there; the dashboard finds each analysis by the same derived id.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

ONNX = Path("apps/web/public/models")
MODELS = (
    ONNX / "pothole-road-anomaly-1.0.0.onnx",
    ONNX / "candidates/mfranzon-yolo26m/mfranzon-yolo26m-1.0.0.onnx",
    ONNX / "candidates/rezzzq-yolo12s/rezzzq-yolo12s-1.0.0.onnx",
)
THRESHOLD = 0.35
SAMPLE_FPS = 12.0


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
    Sample("video-3", "Video 3", Path("samples/2026-05-24-13-36-41.mp4"), "2026-05-24T08:36:41Z"),
    Sample(
        "video-4",
        "Video 4",
        Path("samples/AQM2jwkRRAWtNQQQbVwCZYSJVeIPSrBIr5QGDdjDdjJNWxcqEKshz2co_ddLrKl3P71IMsc.mp4"),
        None,
    ),
)
