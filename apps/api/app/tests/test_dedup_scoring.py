"""Deduplication scoring: the rule that stops 100 cars creating 100 potholes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from app.services.dedup import (
    escalate_severity,
    haversine_m,
    heading_agreement,
    merge_location,
    recency_score,
    score_candidate,
    search_radius_m,
    severity_agreement,
)

NOW = datetime(2026, 8, 17, 9, 0, tzinfo=UTC)
BASE = dict(base_radius_m=10.0, max_radius_m=35.0)

# Tashkent, roughly. One degree of latitude is ~111 km.
LAT, LON = 41.3112, 69.2797


def offset(metres: float) -> float:
    return metres / 111_320.0


def score(**overrides):
    kwargs = dict(
        event_lat=LAT,
        event_lon=LON,
        event_accuracy_m=8.0,
        event_heading_deg=90.0,
        event_severity="large",
        event_detected_at=NOW,
        pothole_lat=LAT,
        pothole_lon=LON,
        pothole_heading_deg=90.0,
        pothole_severity="large",
        pothole_last_seen_at=NOW - timedelta(days=1),
        **BASE,
    )
    kwargs.update(overrides)
    return score_candidate(**kwargs)


class TestDistance:
    def test_haversine_matches_a_known_short_distance(self):
        assert haversine_m(LAT, LON, LAT + offset(100), LON) == pytest.approx(100, abs=1)

    def test_identical_position_scores_highest(self):
        assert score().distance_score == pytest.approx(1.0)

    def test_score_falls_off_with_distance(self):
        near = score(pothole_lat=LAT + offset(2)).total
        far = score(pothole_lat=LAT + offset(8)).total
        assert near > far

    def test_beyond_the_radius_contributes_no_distance_credit(self):
        assert score(pothole_lat=LAT + offset(50)).distance_score == 0.0


class TestSearchRadius:
    def test_a_good_fix_uses_the_base_radius(self):
        assert search_radius_m(4.0, 10.0, 35.0) == 10.0

    def test_a_poor_fix_widens_the_search(self):
        # Otherwise a 25 m fix would never find its own pothole.
        assert search_radius_m(25.0, 10.0, 35.0) == 25.0

    def test_a_terrible_fix_is_capped(self):
        # Without a ceiling, one bad fix would swallow every defect on the block.
        assert search_radius_m(500.0, 10.0, 35.0) == 35.0


class TestHeading:
    def test_same_direction_agrees(self):
        assert heading_agreement(90, 92) == pytest.approx(1.0, abs=0.02)

    def test_opposing_directions_disagree(self):
        # The two carriageways of a road are metres apart but are different defects.
        assert heading_agreement(0, 180) == pytest.approx(0.0)

    def test_wraps_around_north(self):
        assert heading_agreement(359, 1) == pytest.approx(1.0, abs=0.02)

    def test_unknown_heading_is_neutral(self):
        assert heading_agreement(None, 90) == 0.5

    def test_opposing_traffic_scores_lower_than_matching(self):
        assert score(pothole_heading_deg=270).total < score(pothole_heading_deg=90).total


class TestSeverityAndRecency:
    def test_matching_severity_agrees(self):
        assert severity_agreement("large", "large") == 1.0

    def test_opposite_severity_disagrees(self):
        assert severity_agreement("small", "large") == 0.0

    def test_unknown_severity_is_neutral(self):
        assert severity_agreement("unknown", "large") == 0.5

    def test_a_recent_pothole_scores_higher_than_a_dormant_one(self):
        assert recency_score(NOW - timedelta(days=1), NOW) > recency_score(
            NOW - timedelta(days=400), NOW
        )


class TestMergeDecision:
    THRESHOLD = 0.55

    def test_the_same_pothole_seen_again_merges(self):
        # Second car, 3 m off, same direction, same severity.
        assert score(pothole_lat=LAT + offset(3)).total >= self.THRESHOLD

    def test_a_defect_far_down_the_road_does_not_merge(self):
        assert score(pothole_lat=LAT + offset(60)).total < self.THRESHOLD

    def test_opposite_carriageway_at_distance_does_not_merge(self):
        assert score(pothole_lat=LAT + offset(9), pothole_heading_deg=270).total < self.THRESHOLD

    def test_a_poor_fix_can_still_match_its_own_pothole(self):
        # 20 m fix, pothole 15 m away: the widened radius should keep this together.
        assert score(event_accuracy_m=20.0, pothole_lat=LAT + offset(6)).total >= self.THRESHOLD


class TestMergeLocation:
    def test_a_precise_fix_moves_the_marker_more_than_a_vague_one(self):
        precise_lat, _, _ = merge_location(
            existing_lat=LAT, existing_lon=LON, existing_accuracy_m=10, existing_sightings=1,
            new_lat=LAT + offset(10), new_lon=LON, new_accuracy_m=3,
        )
        vague_lat, _, _ = merge_location(
            existing_lat=LAT, existing_lon=LON, existing_accuracy_m=10, existing_sightings=1,
            new_lat=LAT + offset(10), new_lon=LON, new_accuracy_m=40,
        )
        assert precise_lat > vague_lat

    def test_repeated_sightings_never_claim_better_than_the_best_single_fix(self):
        # The measurement that found the bug: six sightings of one pin, each good to
        # 100 m, came out at 70.7 -> 40.8 -> 20.4 -> 9.1 -> 3.7 m, because the already
        # tightened figure was divided again on every merge. Six looks at one pin are not
        # six independent fixes, and a 3.7 m claim built from 100 m fixes is fabricated.
        accuracy = 100.0
        for sightings in range(1, 6):
            _, _, accuracy = merge_location(
                existing_lat=LAT, existing_lon=LON, existing_accuracy_m=accuracy,
                existing_sightings=sightings, new_lat=LAT, new_lon=LON, new_accuracy_m=100,
            )
            assert accuracy == pytest.approx(100.0), f"after {sightings + 1} sightings"

    def test_a_better_fix_tightens_the_estimate_to_that_fix(self):
        _, _, accuracy = merge_location(
            existing_lat=LAT, existing_lon=LON, existing_accuracy_m=40, existing_sightings=3,
            new_lat=LAT, new_lon=LON, new_accuracy_m=6,
        )
        assert accuracy == pytest.approx(6.0)

    def test_a_worse_fix_does_not_loosen_the_estimate(self):
        _, _, accuracy = merge_location(
            existing_lat=LAT, existing_lon=LON, existing_accuracy_m=8, existing_sightings=4,
            new_lat=LAT, new_lon=LON, new_accuracy_m=40,
        )
        assert accuracy == pytest.approx(8.0)

    def test_accuracy_never_claims_better_than_a_metre(self):
        _, _, accuracy = merge_location(
            existing_lat=LAT, existing_lon=LON, existing_accuracy_m=1, existing_sightings=500,
            new_lat=LAT, new_lon=LON, new_accuracy_m=1,
        )
        assert accuracy >= 1.0

    def test_an_established_pothole_is_not_yanked_by_one_new_sighting(self):
        lat, _, _ = merge_location(
            existing_lat=LAT, existing_lon=LON, existing_accuracy_m=6, existing_sightings=20,
            new_lat=LAT + offset(10), new_lon=LON, new_accuracy_m=6,
        )
        assert lat - LAT < offset(1)


class TestSeverityEscalation:
    def test_a_worse_look_raises_the_severity(self):
        assert escalate_severity("small", "large") == "large"

    def test_a_distant_smaller_look_does_not_talk_it_down(self):
        # One close pass showing a bad defect outweighs a string of distant glimpses.
        assert escalate_severity("large", "small") == "large"

    def test_unknown_never_overrides_a_real_grade(self):
        assert escalate_severity("medium", "unknown") == "medium"

    def test_a_real_grade_replaces_unknown(self):
        assert escalate_severity("unknown", "small") == "small"
