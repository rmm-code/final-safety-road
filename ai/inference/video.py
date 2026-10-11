"""Pothole detection over a video file.

    python -m ai.inference.video --input ./input.mp4 --output ./annotated.mp4

Produces an annotated video and a JSON report of unique potholes. This is Milestone 0:
it isolates detector quality from browser and device complexity, and it is the fastest
way to check a newly trained model against real footage.

Without ``--model`` the synthetic detector runs, and every output says so.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from ai.inference.annotate import (
    DETECTION_COLOUR,
    UNTRACKED_COLOUR,
    draw_banner,
    draw_detection,
    draw_trigger_region,
)
from ai.inference.best_frame import BestFrameSelector, laplacian_variance, sharpness_score
from ai.inference.config import DEFAULT_CONFIG_PATH, VisionConfig, load_vision_config
from ai.inference.detector import Detector, create_detector
from ai.inference.report import build_report
from ai.inference.severity import VisualSeverityEngine
from ai.inference.tracking import TrackManager
from ai.inference.types import CapturedFrame, Detection, PotholeTrack, SeverityLevel, SeverityResult

CROP_PADDING_RATIO = 0.35
SYNTHETIC_BANNER = "SYNTHETIC DETECTIONS - NOT MODEL OUTPUT"


@dataclass(slots=True)
class Sample:
    """Detections produced at one analysed media time, with their owning tracks."""

    seconds: float
    detections: list[tuple[Detection, str | None]]


@dataclass(slots=True)
class AnalysisPass:
    samples: list[Sample]
    results: list[tuple[PotholeTrack, SeverityResult]]
    severity_by_track: dict[str, SeverityLevel]
    frames_analysed: int
    raw_detections: int
    rejected_tracks: int
    duration_seconds: float
    source_fps: float
    width: int
    height: int


@dataclass(slots=True)
class AnalysisOutcome:
    report: dict
    annotated_path: Path | None
    json_path: Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m ai.inference.video",
        description="Detect, track and grade potholes in a road video.",
    )
    parser.add_argument("--input", required=True, type=Path, help="Input video file")
    parser.add_argument("--output", type=Path, help="Annotated video to write (optional)")
    parser.add_argument(
        "--json",
        dest="json_path",
        type=Path,
        help=(
            "Report path (default: detections.json next to the annotated video, "
            "or ./detections.json)"
        ),
    )
    parser.add_argument(
        "--model",
        type=Path,
        help="Detector: .pt (Ultralytics) or .onnx; omit to use the synthetic detector",
    )
    parser.add_argument("--device", help="Torch device for a .pt model, e.g. cpu, cuda:0, mps")
    parser.add_argument("--model-version", help="Semantic version recorded on every detection")
    parser.add_argument(
        "--layout",
        choices=["auto", "channels-first", "channels-last"],
        default="auto",
        help="Detector output layout (default: auto-detect)",
    )
    parser.add_argument(
        "--config", type=Path, default=DEFAULT_CONFIG_PATH, help="Vision config YAML"
    )
    parser.add_argument("--sample-fps", type=float, help="Frames per second to analyse")
    parser.add_argument(
        "--confidence", type=float, help="Override the detection confidence threshold"
    )
    parser.add_argument(
        "--crops-dir", type=Path, help="Write the best evidence crop per pothole here"
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output")
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> AnalysisOutcome:
    args = parse_args(argv)

    config = load_vision_config(args.config)
    config = _apply_overrides(config, sample_fps=args.sample_fps, confidence=args.confidence)

    if not args.input.exists():
        raise FileNotFoundError(f"Input video not found: {args.input}")

    detector = create_detector(
        config,
        args.model,
        model_version=args.model_version,
        layout=args.layout,
        device=args.device,
    )

    try:
        outcome = _analyse(args, config, detector)
    finally:
        detector.close()

    return outcome


def _apply_overrides(
    config: VisionConfig, sample_fps: float | None, confidence: float | None
) -> VisionConfig:
    """Apply CLI overrides without mutating the loaded configuration."""
    import dataclasses

    updated = config
    if sample_fps is not None:
        if sample_fps <= 0:
            raise ValueError("--sample-fps must be positive")
        updated = dataclasses.replace(updated, sample_fps=sample_fps)
    if confidence is not None:
        if not 0 <= confidence <= 1:
            raise ValueError("--confidence must be between 0 and 1")
        updated = dataclasses.replace(
            updated,
            detection=dataclasses.replace(updated.detection, confidence_threshold=confidence),
        )
    return updated


def _analyse(args: argparse.Namespace, config: VisionConfig, detector: Detector) -> AnalysisOutcome:
    """Analyse the video, then render the annotation in a second pass.

    Two passes rather than one because a track's severity is only known once the track
    finalises, which happens after the pothole has left the frame. Rendering during the
    analysis pass would therefore label every pothole as unknown for exactly the frames
    in which it is visible. Decoding twice is cheap for an offline batch job.
    """
    analysis = _analyse_samples(args, config, detector)

    if args.output is not None:
        _render_annotated(args.input, args.output, config, analysis, detector.info.is_synthetic)

    report = build_report(
        source_name=args.input.name,
        duration_seconds=analysis.duration_seconds,
        width=analysis.width,
        height=analysis.height,
        detector=detector.info,
        config=config,
        frames_analysed=analysis.frames_analysed,
        raw_detections=analysis.raw_detections,
        rejected_tracks=analysis.rejected_tracks,
        other_classes=detector.other_class_counts,
        tracks=analysis.results,
    )

    json_path = args.json_path or (
        args.output.with_name("detections.json") if args.output else Path("detections.json")
    )
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    if not args.quiet:
        _print_summary(report, json_path, args.output)

    return AnalysisOutcome(report=report, annotated_path=args.output, json_path=json_path)


def _analyse_samples(
    args: argparse.Namespace, config: VisionConfig, detector: Detector
) -> AnalysisPass:
    """First pass: sample frames, detect, track, grade and select evidence frames."""
    capture = cv2.VideoCapture(str(args.input))
    if not capture.isOpened():
        raise RuntimeError(f"Could not open video: {args.input}")

    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))

    if args.crops_dir is not None:
        args.crops_dir.mkdir(parents=True, exist_ok=True)

    tracker = TrackManager(config)
    severity_engine = VisualSeverityEngine(config)
    selector = BestFrameSelector(config)

    results: list[tuple[PotholeTrack, SeverityResult]] = []
    severity_by_track: dict[str, SeverityLevel] = {}
    samples: list[Sample] = []
    # Pixels of the current best candidate per track, held outside the selector so only
    # the winning crop is ever retained.
    best_pixels: dict[str, np.ndarray] = {}
    rejected_tracks = 0
    raw_detections = 0
    sample_index = 0
    frame_index = 0
    sample_interval = 1.0 / config.sample_fps

    def drain() -> None:
        nonlocal rejected_tracks
        for track in tracker.take_finalized_tracks():
            track.best_frame = selector.take(track.local_track_id)
            severity = severity_engine.calculate(track)
            severity_by_track[track.local_track_id] = severity.level
            results.append((track, severity))
            _write_crop(args.crops_dir, track, best_pixels.pop(track.local_track_id, None))
        for track in tracker.take_rejected_tracks():
            selector.discard(track.local_track_id)
            best_pixels.pop(track.local_track_id, None)
            rejected_tracks += 1

    while True:
        ok, frame = capture.read()
        if not ok:
            break

        seconds = frame_index / source_fps
        if seconds >= sample_index * sample_interval:
            detections = detector.detect(frame)
            raw_detections += len(detections)

            update = tracker.update(
                detections, timestamp_ms=seconds * 1000, frame_index=sample_index
            )

            owners: dict[int, str] = {}
            for track in update.matched + update.created:
                observation = track.observations[-1]
                if observation.frame_index == sample_index:
                    owners[id(observation.detection)] = track.local_track_id
                _consider_best_frame(
                    track, frame, selector, config, seconds, sample_index, best_pixels
                )

            samples.append(
                Sample(
                    seconds=seconds,
                    detections=[(d, owners.get(id(d))) for d in detections],
                )
            )
            drain()

            sample_index += 1
            if not args.quiet and total_frames > 0 and sample_index % 25 == 0:
                percent = 100 * frame_index / total_frames
                print(
                    f"  {percent:5.1f}%  frame {frame_index}/{total_frames}  "
                    f"{len(results)} pothole(s)",
                    file=sys.stderr,
                )

        frame_index += 1

    tracker.flush()
    drain()
    capture.release()

    results.sort(key=lambda item: item[0].first_seen_at)

    return AnalysisPass(
        samples=samples,
        results=results,
        severity_by_track=severity_by_track,
        frames_analysed=sample_index,
        raw_detections=raw_detections,
        rejected_tracks=rejected_tracks,
        duration_seconds=frame_index / source_fps if source_fps else 0.0,
        source_fps=source_fps,
        width=width,
        height=height,
    )


def _render_annotated(
    input_path: Path,
    output_path: Path,
    config: VisionConfig,
    analysis: AnalysisPass,
    synthetic: bool,
) -> None:
    """Second pass: draw the analysed detections, now labelled with final severities."""
    capture = cv2.VideoCapture(str(input_path))
    if not capture.isOpened():
        raise RuntimeError(f"Could not re-open video for annotation: {input_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    # mp4v rather than H.264: OpenCV builds usually ship without an H.264 encoder.
    writer = cv2.VideoWriter(
        str(output_path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        analysis.source_fps,
        (analysis.width, analysis.height),
    )
    if not writer.isOpened():
        capture.release()
        raise RuntimeError(f"Could not open the output video for writing: {output_path}")

    frame_index = 0
    sample_cursor = 0
    current: list[tuple[Detection, str | None]] = []

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break

            seconds = frame_index / analysis.source_fps
            # Hold the most recent analysed result until the next sample arrives.
            while (
                sample_cursor < len(analysis.samples)
                and analysis.samples[sample_cursor].seconds <= seconds
            ):
                current = analysis.samples[sample_cursor].detections
                sample_cursor += 1

            draw_trigger_region(frame, config.trigger_region_top_y)
            for detection, track_id in current:
                _draw(frame, detection, track_id, analysis.severity_by_track)
            if synthetic:
                draw_banner(frame, SYNTHETIC_BANNER)

            writer.write(frame)
            frame_index += 1
    finally:
        capture.release()
        writer.release()


def _consider_best_frame(
    track: PotholeTrack,
    frame: np.ndarray,
    selector: BestFrameSelector,
    config: VisionConfig,
    seconds: float,
    sample_index: int,
    best_pixels: dict[str, np.ndarray],
) -> None:
    """Offer the current frame to a track's best-frame selector.

    Scoring runs every frame because it is cheap; the crop is only kept when the
    candidate wins.
    """
    observation = track.observations[-1]
    if observation.frame_index != sample_index:
        return

    height, width = frame.shape[:2]
    x, y, crop_width, crop_height = observation.detection.bbox.to_pixels(width, height)
    if crop_width < 3 or crop_height < 3:
        return

    crop = frame[y : y + crop_height, x : x + crop_width]
    sharpness = sharpness_score(
        laplacian_variance(crop), config.best_frame.sharpness_half_saturation
    )
    score = selector.score(observation.detection.confidence, observation.detection.bbox, sharpness)
    if not selector.would_accept(track.local_track_id, score):
        return

    selector.commit(
        track.local_track_id,
        CapturedFrame(
            timestamp_ms=seconds * 1000,
            frame_index=sample_index,
            score=score,
            confidence=observation.detection.confidence,
            bbox=observation.detection.bbox,
        ),
    )

    px, py, pw, ph = observation.detection.bbox.to_pixels(width, height, CROP_PADDING_RATIO)
    best_pixels[track.local_track_id] = frame[py : py + ph, px : px + pw].copy()


def _write_crop(crops_dir: Path | None, track: PotholeTrack, pixels: np.ndarray | None) -> None:
    if crops_dir is None or track.best_frame is None or pixels is None or pixels.size == 0:
        return
    path = crops_dir / f"{track.local_track_id}.jpg"
    cv2.imwrite(str(path), pixels)
    track.best_frame.crop_path = str(path)


def _draw(
    frame: np.ndarray,
    detection: Detection,
    track_id: str | None,
    severity_by_track: dict[str, SeverityLevel],
) -> None:
    confidence = f"{round(detection.confidence * 100)}%"
    if track_id is None:
        draw_detection(frame, detection, f"UNTRACKED {confidence}", UNTRACKED_COLOUR, tracked=False)
        return

    level = severity_by_track.get(track_id)
    label = f"POTHOLE {confidence}" if level is None else f"POTHOLE {level.upper()} {confidence}"
    draw_detection(frame, detection, label, DETECTION_COLOUR, tracked=True)


def _print_summary(report: dict, json_path: Path, annotated_path: Path | None) -> None:
    summary = report["summary"]
    engine = report["engine"]

    print()
    if engine["isSynthetic"]:
        print("*** SYNTHETIC RUN - detections below are fabricated, not model output ***")
    print(f"Source            {report['source']['name']}  ({report['source']['durationSeconds']}s)")
    print(f"Engine            {engine['kind']} / {engine['modelVersion']} ({engine['backend']})")
    analysis = report["analysis"]
    print(f"Frames analysed   {analysis['framesAnalysed']} at {analysis['sampleFps']} FPS")
    print(f"Frame detections  {analysis['rawDetections']}")
    print(f"Unique potholes   {summary['totalPotholes']}")
    print(f"  large           {summary['large']}")
    print(f"  medium          {summary['medium']}")
    print(f"  small           {summary['small']}")
    print(f"  unknown         {summary['unknown']}")
    print(f"Filtered out      {analysis['rejectedTracks']} track(s) below the confirmation rules")
    print(f"Avg confidence    {summary['averageConfidence'] * 100:.0f}%")
    print("Location          unavailable (a video file carries no GPS telemetry)")
    print(f"Report            {json_path}")
    if annotated_path is not None:
        print(f"Annotated video   {annotated_path}")


def main(argv: list[str] | None = None) -> int:
    try:
        run(argv)
    except (FileNotFoundError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
