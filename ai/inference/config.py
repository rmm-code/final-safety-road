"""Loader for the canonical vision configuration.

``ai/configs/vision.yaml`` is the single source of truth for detection, tracking,
severity and best-frame parameters. The browser mirrors it in
``packages/vision-web/src/config/vision-config.ts``, and a unit test there fails the
build if the two drift. Thresholds are never hard-coded anywhere else.

YAML keys are camelCase so both languages can compare the structures literally; they are
exposed here as ordinary snake_case attributes.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "configs" / "vision.yaml"


@dataclass(frozen=True, slots=True)
class ModelConfig:
    input_size: int
    class_names: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DetectionConfig:
    confidence_threshold: float
    nms_iou_threshold: float
    max_detections: int


@dataclass(frozen=True, slots=True)
class TrackingConfig:
    iou_match_threshold: float
    max_missed_frames: int
    motion_prediction: bool
    centre_distance_gate: float
    scale_ratio_gate: float
    min_observations: int
    min_max_confidence: float
    min_duration_ms: float


@dataclass(frozen=True, slots=True)
class SeverityConfidenceWeights:
    base: float
    detection: float
    persistence: float
    trigger_region: float


@dataclass(frozen=True, slots=True)
class SeverityConfig:
    area_score_reference: float
    small_max: float
    medium_max: float
    persistence_reference_observations: int
    confidence_weights: SeverityConfidenceWeights


@dataclass(frozen=True, slots=True)
class BestFrameWeights:
    confidence: float
    area: float
    sharpness: float
    centrality: float


@dataclass(frozen=True, slots=True)
class BestFrameConfig:
    edge_margin: float
    edge_clip_penalty: float
    sharpness_half_saturation: float
    weights: BestFrameWeights


@dataclass(frozen=True, slots=True)
class MockConfig:
    seed: int
    virtual_fps: float
    min_gap_seconds: float
    max_gap_seconds: float
    spawn_distance_m: float
    exit_distance_m: float
    horizon_y: float
    perspective_k: float
    lateral_spread_k: float
    speed_mps_min: float
    speed_mps_max: float
    pothole_width_min_m: float
    pothole_width_max_m: float
    confidence_width_reference: float
    dropout_probability: float
    false_positive_probability: float


@dataclass(frozen=True, slots=True)
class VisionConfig:
    model: ModelConfig
    detection: DetectionConfig
    tracking: TrackingConfig
    trigger_region_top_y: float
    severity: SeverityConfig
    best_frame: BestFrameConfig
    sample_fps: float
    drive_target_fps: float
    mock: MockConfig


def load_vision_config(path: Path | str | None = None) -> VisionConfig:
    """Read the canonical configuration file."""
    config_path = Path(path) if path is not None else DEFAULT_CONFIG_PATH
    raw: dict[str, Any] = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    return parse_vision_config(raw)


def parse_vision_config(raw: dict[str, Any]) -> VisionConfig:
    model = raw["model"]
    detection = raw["detection"]
    tracking = raw["tracking"]
    severity = raw["severity"]
    weights = severity["confidenceWeights"]
    best_frame = raw["bestFrame"]
    best_frame_weights = best_frame["weights"]
    mock = raw["mock"]

    return VisionConfig(
        model=ModelConfig(
            input_size=int(model["inputSize"]),
            class_names=tuple(model["classNames"]),
        ),
        detection=DetectionConfig(
            confidence_threshold=float(detection["confidenceThreshold"]),
            nms_iou_threshold=float(detection["nmsIouThreshold"]),
            max_detections=int(detection["maxDetections"]),
        ),
        tracking=TrackingConfig(
            iou_match_threshold=float(tracking["iouMatchThreshold"]),
            max_missed_frames=int(tracking["maxMissedFrames"]),
            motion_prediction=bool(tracking["motionPrediction"]),
            centre_distance_gate=float(tracking["centreDistanceGate"]),
            scale_ratio_gate=float(tracking["scaleRatioGate"]),
            min_observations=int(tracking["minObservations"]),
            min_max_confidence=float(tracking["minMaxConfidence"]),
            min_duration_ms=float(tracking["minDurationMs"]),
        ),
        trigger_region_top_y=float(raw["triggerRegion"]["topY"]),
        severity=SeverityConfig(
            area_score_reference=float(severity["areaScoreReference"]),
            small_max=float(severity["smallMax"]),
            medium_max=float(severity["mediumMax"]),
            persistence_reference_observations=int(severity["persistenceReferenceObservations"]),
            confidence_weights=SeverityConfidenceWeights(
                base=float(weights["base"]),
                detection=float(weights["detection"]),
                persistence=float(weights["persistence"]),
                trigger_region=float(weights["triggerRegion"]),
            ),
        ),
        best_frame=BestFrameConfig(
            edge_margin=float(best_frame["edgeMargin"]),
            edge_clip_penalty=float(best_frame["edgeClipPenalty"]),
            sharpness_half_saturation=float(best_frame["sharpnessHalfSaturation"]),
            weights=BestFrameWeights(
                confidence=float(best_frame_weights["confidence"]),
                area=float(best_frame_weights["area"]),
                sharpness=float(best_frame_weights["sharpness"]),
                centrality=float(best_frame_weights["centrality"]),
            ),
        ),
        sample_fps=float(raw["analysis"]["sampleFps"]),
        drive_target_fps=float(raw["drive"]["targetFps"]),
        mock=MockConfig(
            seed=int(mock["seed"]),
            virtual_fps=float(mock["virtualFps"]),
            min_gap_seconds=float(mock["minGapSeconds"]),
            max_gap_seconds=float(mock["maxGapSeconds"]),
            spawn_distance_m=float(mock["spawnDistanceM"]),
            exit_distance_m=float(mock["exitDistanceM"]),
            horizon_y=float(mock["horizonY"]),
            perspective_k=float(mock["perspectiveK"]),
            lateral_spread_k=float(mock["lateralSpreadK"]),
            speed_mps_min=float(mock["speedMpsMin"]),
            speed_mps_max=float(mock["speedMpsMax"]),
            pothole_width_min_m=float(mock["potholeWidthMinM"]),
            pothole_width_max_m=float(mock["potholeWidthMaxM"]),
            confidence_width_reference=float(mock["confidenceWidthReference"]),
            dropout_probability=float(mock["dropoutProbability"]),
            false_positive_probability=float(mock["falsePositiveProbability"]),
        ),
    )
