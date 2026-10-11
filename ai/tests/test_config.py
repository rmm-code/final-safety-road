"""The configuration file is the single source of truth for both implementations."""

from __future__ import annotations

import pytest
import yaml

from ai.inference.config import DEFAULT_CONFIG_PATH, load_vision_config, parse_vision_config


def test_loads_the_canonical_file():
    config = load_vision_config()
    assert config.model.class_names == ("pothole",)
    assert config.sample_fps > 0


def test_severity_bands_are_ordered_inside_the_unit_interval(config):
    assert 0 < config.severity.small_max < config.severity.medium_max < 1


def test_severity_confidence_weights_sum_to_one(config):
    weights = config.severity.confidence_weights
    total = weights.base + weights.detection + weights.persistence + weights.trigger_region
    assert total == pytest.approx(1.0)


def test_trigger_region_sits_in_the_lower_half(config):
    assert 0.5 < config.trigger_region_top_y < 1.0


def test_tracking_gate_is_looser_than_nms(config):
    # Potholes move a long way between analysed frames, so association must tolerate
    # far less overlap than duplicate suppression does.
    assert config.tracking.iou_match_threshold < config.detection.nms_iou_threshold


def test_rejects_a_file_missing_a_required_section():
    raw = yaml.safe_load(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))
    del raw["severity"]["smallMax"]
    with pytest.raises(KeyError):
        parse_vision_config(raw)


def test_video_analysis_samples_more_often_than_the_live_camera(config):
    # Offline analysis can afford accuracy; the live camera is bounded by the phone.
    assert config.sample_fps > config.drive_target_fps


def test_live_rate_stays_within_what_a_phone_sustains(config):
    assert 4 <= config.drive_target_fps <= 10
