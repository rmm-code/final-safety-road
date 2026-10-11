"""Pre-analysed sample videos (`ai/samples`)."""

from __future__ import annotations

from pathlib import Path

from ai.inference.config import VisionConfig
from ai.inference.detector import MockDetector
from ai.samples.analyse import analyse
from ai.samples.ids import analysis_id

MERGED = "pothole-road-anomaly-1.0.0+mfranzon-yolo26m-1.0.0+rezzzq-yolo12s-1.0.0"


def test_the_id_matches_the_one_the_web_app_derives() -> None:
    # Computed by features/videos/lib/analysis-id.ts for the same inputs.
    assert analysis_id("demo:video-2", MERGED, 0.35, 12) == "b74149fd-b3bb-88ac-a229-1e7a89f40dec"
    assert analysis_id("demo:video-2", MERGED, 0.35, 12.0) == analysis_id(
        "demo:video-2", MERGED, 0.35, 12
    )


def test_exports_the_browser_analysis_format(
    synthetic_video: Path, config: VisionConfig, tmp_path: Path
) -> None:
    analysis = analyse(
        synthetic_video, MockDetector(config, selection_reason="test"), config, tmp_path
    )

    assert analysis["framesAnalysed"] == len(analysis["frames"]) > 0
    assert analysis["modelVersion"].startswith("mock-")
    frame = next(f for f in analysis["frames"] if f["detections"])
    detection = frame["detections"][0]
    assert set(detection) == {"detection", "trackId"}
    assert set(detection["detection"]["bbox"]) == {"x", "y", "width", "height"}
    for pothole in analysis["potholes"]:
        assert {"trackId", "firstSeenSeconds", "severity", "confidence", "maxArea"} <= set(pothole)
        assert (tmp_path / f"{pothole['trackId']}.jpg").exists()
