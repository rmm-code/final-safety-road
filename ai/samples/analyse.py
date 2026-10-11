"""Run the product pipeline on a video and export it in the browser's analysis format."""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np

from ai.inference.config import VisionConfig
from ai.inference.detector import Detector, DetectorInfo
from ai.inference.report import build_report
from ai.inference.types import Detection
from ai.inference.video import _analyse_samples


class _Timed:
    """A detector that also measures its own inference time."""

    def __init__(self, inner: Detector) -> None:
        self.inner = inner
        self.total_ms = 0.0
        self.calls = 0

    @property
    def info(self) -> DetectorInfo:
        return self.inner.info

    @property
    def other_class_counts(self) -> dict[str, int]:
        return self.inner.other_class_counts

    def detect(self, frame: np.ndarray) -> list[Detection]:
        started = time.perf_counter()
        found = self.inner.detect(frame)
        self.total_ms += (time.perf_counter() - started) * 1000
        self.calls += 1
        return found

    def close(self) -> None:
        self.inner.close()


def _detection(d: Detection, track_id: str | None) -> dict:
    box = d.bbox
    return {
        "detection": {
            "classId": d.class_id,
            "className": d.class_name,
            "confidence": round(d.confidence, 4),
            "bbox": {
                k: round(v, 5)
                for k, v in (
                    ("x", box.x),
                    ("y", box.y),
                    ("width", box.width),
                    ("height", box.height),
                )
            },
        },
        "trackId": track_id,
    }


def analyse(video: Path, detector: Detector, config: VisionConfig, crops_dir: Path) -> dict:
    """Analyse one video; crops land in crops_dir as <trackId>.jpg."""
    timed = _Timed(detector)
    run = _analyse_samples(
        argparse.Namespace(input=video, crops_dir=crops_dir, quiet=True), config, timed
    )
    report = build_report(
        source_name=video.name,
        duration_seconds=run.duration_seconds,
        width=run.width,
        height=run.height,
        detector=timed.info,
        config=config,
        frames_analysed=run.frames_analysed,
        raw_detections=run.raw_detections,
        rejected_tracks=run.rejected_tracks,
        other_classes=timed.other_class_counts,
        tracks=run.results,
    )
    return {
        "modelVersion": timed.info.model_version,
        "durationSeconds": round(run.duration_seconds, 3),
        "width": run.width,
        "height": run.height,
        "framesAnalysed": run.frames_analysed,
        "rawDetections": run.raw_detections,
        "rejectedTracks": run.rejected_tracks,
        "averageInferenceMs": round(timed.total_ms / timed.calls, 1) if timed.calls else 0.0,
        "potholes": [
            {
                "trackId": t["trackId"],
                "firstSeenSeconds": t["firstSeenSeconds"],
                "lastSeenSeconds": t["lastSeenSeconds"],
                "bestFrameSeconds": t["bestFrameSeconds"],
                "confidence": t["maxConfidence"],
                "severity": t["severity"],
                "severityScore": t["severityScore"],
                "severityConfidence": t["severityConfidence"],
                "observationCount": t["observationCount"],
                "maxArea": t["maxArea"],
            }
            for t in report["tracks"]
        ],
        "frames": [
            {
                "seconds": round(s.seconds, 3),
                "detections": [_detection(d, owner) for d, owner in s.detections],
            }
            for s in run.samples
        ],
    }
