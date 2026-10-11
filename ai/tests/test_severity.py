"""Visual severity thresholds and the features that drive them."""

from __future__ import annotations

import dataclasses

import pytest

from ai.inference.config import VisionConfig
from ai.inference.geometry import BoundingBox
from ai.inference.severity import VisualSeverityEngine, area_score, centrality_score
from ai.inference.types import Detection, DetectionObservation, PotholeTrack


def make_track(
    config: VisionConfig,
    areas: list[float],
    in_trigger_region: bool = True,
    max_confidence: float = 0.9,
) -> PotholeTrack:
    observations = []
    for index, area in enumerate(areas):
        width = (area / 0.6) ** 0.5 if area > 0 else 0.0
        height = area / width if width > 0 else 0.0
        observations.append(
            DetectionObservation(
                timestamp_ms=index * 167,
                frame_index=index,
                detection=Detection(
                    0, "pothole", max_confidence, BoundingBox(0.4, 0.75, width, height)
                ),
                area=area,
                in_trigger_region=in_trigger_region,
            )
        )
    return PotholeTrack(
        local_track_id="track-001",
        state="CONFIRMED",
        first_seen_at=0,
        last_seen_at=max(0, (len(areas) - 1) * 167),
        max_confidence=max_confidence,
        max_area=max(areas, default=0.0),
        observations=observations,
    )


def area_for_score(config: VisionConfig, score: float) -> float:
    return score * score * config.severity.area_score_reference


class TestThresholds:
    def test_small(self, config):
        engine = VisualSeverityEngine(config)
        track = make_track(config, [area_for_score(config, config.severity.small_max - 0.05)])
        assert engine.calculate(track).level == "small"

    def test_small_medium_boundary_is_small(self, config):
        engine = VisualSeverityEngine(config)
        result = engine.calculate(
            make_track(config, [area_for_score(config, config.severity.small_max)])
        )
        assert result.score == pytest.approx(config.severity.small_max, abs=1e-9)
        assert result.level == "small"

    def test_just_above_the_boundary_is_medium(self, config):
        engine = VisualSeverityEngine(config)
        track = make_track(config, [area_for_score(config, config.severity.small_max + 0.01)])
        assert engine.calculate(track).level == "medium"

    def test_medium_large_boundary_is_medium(self, config):
        engine = VisualSeverityEngine(config)
        track = make_track(config, [area_for_score(config, config.severity.medium_max)])
        assert engine.calculate(track).level == "medium"

    def test_just_above_that_boundary_is_large(self, config):
        engine = VisualSeverityEngine(config)
        track = make_track(config, [area_for_score(config, config.severity.medium_max + 0.01)])
        assert engine.calculate(track).level == "large"

    def test_score_saturates_at_one(self, config):
        engine = VisualSeverityEngine(config)
        result = engine.calculate(make_track(config, [0.5]))
        assert result.score == 1.0
        assert result.level == "large"

    def test_bands_come_from_configuration_not_code(self, config):
        sample = make_track(config, [area_for_score(config, 0.5)])
        strict = dataclasses.replace(
            config, severity=dataclasses.replace(config.severity, small_max=0.1, medium_max=0.2)
        )
        assert VisualSeverityEngine(config).calculate(sample).level == "medium"
        assert VisualSeverityEngine(strict).calculate(sample).level == "large"


class TestMeasurementChoice:
    def test_measures_inside_the_trigger_region(self, config):
        engine = VisualSeverityEngine(config)
        track = make_track(config, [area_for_score(config, 0.9), area_for_score(config, 0.4)])
        # The larger observation is far from the vehicle and must not drive severity.
        track.observations[0] = dataclasses.replace(track.observations[0], in_trigger_region=False)
        result = engine.calculate(track)
        assert result.score == pytest.approx(0.4, abs=1e-9)
        assert "trigger region" in result.rationale

    def test_falls_back_to_the_full_frame(self, config):
        engine = VisualSeverityEngine(config)
        track = make_track(config, [area_for_score(config, 0.5)], in_trigger_region=False)
        result = engine.calculate(track)
        assert result.score == pytest.approx(0.5, abs=1e-9)
        assert "full frame" in result.rationale

    def test_unknown_without_observations(self, config):
        result = VisualSeverityEngine(config).calculate(make_track(config, []))
        assert result.level == "unknown"
        assert result.confidence == 0.0

    def test_unknown_when_every_observation_has_no_area(self, config):
        assert VisualSeverityEngine(config).calculate(make_track(config, [0.0])).level == "unknown"


class TestConfidence:
    def test_rewards_persistence_confidence_and_proximity(self, config):
        engine = VisualSeverityEngine(config)
        weak = engine.calculate(
            make_track(
                config, [area_for_score(config, 0.5)], in_trigger_region=False, max_confidence=0.6
            )
        )
        strong = engine.calculate(
            make_track(config, [area_for_score(config, 0.5)] * 10, max_confidence=0.95)
        )
        assert strong.confidence > weak.confidence
        assert 0 < weak.confidence <= 1
        assert strong.confidence <= 1

    def test_full_confidence_needs_a_long_close_confident_track(self, config):
        engine = VisualSeverityEngine(config)
        count = config.severity.persistence_reference_observations
        ideal = engine.calculate(
            make_track(config, [area_for_score(config, 0.8)] * count, max_confidence=1.0)
        )
        assert ideal.confidence == pytest.approx(1.0)


class TestScoringHelpers:
    def test_area_score_uses_a_square_root_curve(self, config):
        reference = config.severity.area_score_reference
        assert area_score(reference, reference) == pytest.approx(1.0)
        assert area_score(reference / 4, reference) == pytest.approx(0.5)
        assert area_score(0, reference) == 0.0

    def test_centrality_penalises_clipped_boxes(self, config):
        margin = config.best_frame.edge_margin
        penalty = config.best_frame.edge_clip_penalty
        inset = BoundingBox(0.4, 0.4, 0.2, 0.2)
        clipped = BoundingBox(0.0, 0.4, 0.2, 0.2)
        assert centrality_score(inset, margin, penalty) == pytest.approx(1.0)
        assert centrality_score(clipped, margin, penalty) == pytest.approx(penalty)
