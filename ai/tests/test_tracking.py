"""Track association: many frame detections must become one pothole."""

from __future__ import annotations

import dataclasses

import pytest

from ai.inference.geometry import BoundingBox
from ai.inference.tracking import TrackManager, is_in_trigger_region
from ai.inference.types import Detection


def detection(
    y: float, x: float = 0.45, width: float = 0.1, height: float = 0.08, confidence: float = 0.9
) -> Detection:
    return Detection(0, "pothole", confidence, BoundingBox(x, y, width, height))


def run(
    manager: TrackManager, frames: list[list[Detection]], frame_ms: float, start: int = 0
) -> None:
    for offset, detections in enumerate(frames):
        index = start + offset
        manager.update(detections, timestamp_ms=index * frame_ms, frame_index=index)


@pytest.fixture
def frame_ms() -> float:
    """Frame interval for these tests, stated explicitly.

    Deriving it from `analysis.sampleFps` coupled the tracker's tests to a value they do
    not test, and hid a real interaction: `minDurationMs` is wall-clock, so how many
    sightings satisfy it depends on the rate. At 6 FPS three sightings span 333 ms and
    clear the 200 ms minimum; at 12 FPS they span 167 ms and a fourth is needed. That is
    intended - a momentary flicker is measured in time, not in frames.
    """
    return 1000 / 6


def approach_sequence(width_m: float, speed_mps: float, sample_fps: float) -> list[list[Detection]]:
    """A pothole on the road plane as a windshield-mounted phone sees it.

    It barely moves near the horizon, then accelerates down the image and grows fast.
    """
    frames: list[list[Detection]] = []
    distance = 40.0
    while distance > 3.0:
        width = width_m / (1.4 * distance)
        height = width * 0.6
        centre_y = 0.5 + 1.5 / distance
        frames.append([detection(centre_y - height / 2, 0.5 - width / 2, width, height)])
        distance -= speed_mps / sample_fps
    return frames


class TestAssociation:
    def test_one_pothole_seen_many_times_is_one_track(self, config, frame_ms):
        manager = TrackManager(config)
        run(manager, [[detection(y)] for y in (0.40, 0.42, 0.44, 0.46, 0.48)], frame_ms)

        assert len(manager.active_tracks) == 1
        assert len(manager.active_tracks[0].observations) == 5
        assert manager.active_tracks[0].state == "CONFIRMED"

    def test_potholes_in_different_lanes_stay_apart(self, config, frame_ms):
        manager = TrackManager(config)
        run(
            manager,
            [[detection(y, x=0.15), detection(y, x=0.7)] for y in (0.40, 0.42, 0.44)],
            frame_ms,
        )
        assert len(manager.active_tracks) == 2

    def test_a_detection_is_claimed_by_at_most_one_track(self, config, frame_ms):
        manager = TrackManager(config)
        run(manager, [[detection(0.40)], [detection(0.42), detection(0.425)]], frame_ms)
        assert sum(len(t.observations) for t in manager.active_tracks) == 3
        assert len(manager.active_tracks) == 2

    def test_survives_a_missed_frame(self, config, frame_ms):
        manager = TrackManager(config)
        run(manager, [[detection(0.40)], [detection(0.42)], [], [detection(0.46)]], frame_ms)
        assert len(manager.active_tracks) == 1
        assert len(manager.active_tracks[0].observations) == 3

    def test_closes_after_the_miss_tolerance(self, config, frame_ms):
        manager = TrackManager(config)
        blanks: list[list[Detection]] = [[] for _ in range(config.tracking.max_missed_frames + 1)]
        run(manager, [[detection(0.40)], [detection(0.42)], [detection(0.44)], *blanks], frame_ms)
        assert manager.active_tracks == []
        assert len(manager.take_finalized_tracks()) == 1

    def test_ignores_detections_below_the_threshold(self, config, frame_ms):
        manager = TrackManager(config)
        run(
            manager,
            [[detection(0.40, confidence=0.2)], [detection(0.42, confidence=0.1)]],
            frame_ms,
        )
        assert manager.active_tracks == []


class TestPerspectiveMotion:
    def test_follows_a_pothole_from_the_horizon_to_the_bumper(self, config, frame_ms):
        manager = TrackManager(config)
        frames = approach_sequence(0.9, 14, 6)
        run(manager, frames, frame_ms)

        assert len(manager.active_tracks) == 1
        track = manager.active_tracks[0]
        assert len(track.observations) == len(frames)
        assert any(o.in_trigger_region for o in track.observations)

    def test_keeps_the_largest_close_range_observation(self, config, frame_ms):
        manager = TrackManager(config)
        frames = approach_sequence(0.9, 14, 6)
        run(manager, frames, frame_ms)
        manager.flush()

        finalized = manager.take_finalized_tracks()
        assert len(finalized) == 1
        # Severity reads the peak area; if the tail of the track broke away, every
        # pothole would be measured from too far back and look smaller than it is.
        assert finalized[0].max_area == pytest.approx(frames[-1][0].bbox.area)

    def test_bridges_a_dropped_frame_anywhere_in_the_approach(self, config, frame_ms):
        template = approach_sequence(0.9, 14, 6)
        for dropped in range(len(template)):
            manager = TrackManager(config)
            frames = [[] if index == dropped else frame for index, frame in enumerate(template)]
            run(manager, frames, frame_ms)
            manager.flush()
            total = len(manager.take_finalized_tracks()) + len(manager.take_rejected_tracks())
            assert total == 1, f"dropping frame {dropped} split the track"

    def test_does_not_merge_potholes_that_are_side_by_side(self, config, frame_ms):
        manager = TrackManager(config)
        template = approach_sequence(0.6, 12, 6)
        frames = [
            [
                dataclasses.replace(
                    frame[0], bbox=dataclasses.replace(frame[0].bbox, x=frame[0].bbox.x - 0.16)
                ),
                dataclasses.replace(
                    frame[0], bbox=dataclasses.replace(frame[0].bbox, x=frame[0].bbox.x + 0.16)
                ),
            ]
            for frame in template
        ]
        run(manager, frames, frame_ms)

        assert len(manager.active_tracks) == 2
        for track in manager.active_tracks:
            assert len(track.observations) == len(frames)

    def test_does_not_attach_a_far_away_detection(self, config, frame_ms):
        manager = TrackManager(config)
        run(
            manager,
            [
                [detection(0.40, x=0.2)],
                [detection(0.42, x=0.2)],
                [detection(0.44, x=0.2), detection(0.44, x=0.85)],
            ],
            frame_ms,
        )
        assert len(manager.active_tracks) == 2
        assert len(manager.active_tracks[0].observations) == 3
        assert len(manager.active_tracks[1].observations) == 1


class TestStateMachine:
    def test_walks_candidate_tracking_confirmed_finalized(self, config, frame_ms):
        manager = TrackManager(config)

        manager.update([detection(0.40)], timestamp_ms=0, frame_index=0)
        assert manager.active_tracks[0].state == "CANDIDATE"

        manager.update([detection(0.42)], timestamp_ms=frame_ms, frame_index=1)
        assert manager.active_tracks[0].state == "TRACKING"

        manager.update([detection(0.44)], timestamp_ms=frame_ms * 2, frame_index=2)
        assert manager.active_tracks[0].state == "CONFIRMED"

        finalized = manager.flush()
        assert finalized[0].state == "FINALIZED"
        assert len(manager.take_finalized_tracks()) == 1

    def test_rejects_a_track_with_too_few_observations(self, config, frame_ms):
        manager = TrackManager(config)
        run(manager, [[detection(0.40)], [detection(0.42)]], frame_ms)
        manager.flush()

        assert manager.take_finalized_tracks() == []
        rejected = manager.take_rejected_tracks()
        assert len(rejected) == 1
        assert rejected[0].state == "REJECTED_LOW_CONFIDENCE"

    def test_rejects_a_persistent_but_unconfident_track(self, config, frame_ms):
        manager = TrackManager(config)
        run(
            manager,
            [
                [detection(y, confidence=c)]
                for y, c in ((0.40, 0.40), (0.42, 0.45), (0.44, 0.50), (0.46, 0.42))
            ],
            frame_ms,
        )
        manager.flush()
        assert manager.take_finalized_tracks() == []
        assert len(manager.take_rejected_tracks()) == 1

    def test_rejects_a_track_that_never_lasts_long_enough(self, config):
        manager = TrackManager(config)
        for frame_index in range(3):
            manager.update([detection(0.40)], timestamp_ms=0, frame_index=frame_index)
        manager.flush()
        assert manager.take_finalized_tracks() == []
        assert len(manager.take_rejected_tracks()) == 1

    def test_drains_finalised_tracks_once(self, config, frame_ms):
        manager = TrackManager(config)
        run(manager, [[detection(y)] for y in (0.40, 0.42, 0.44)], frame_ms)
        manager.flush()
        assert len(manager.take_finalized_tracks()) == 1
        assert manager.take_finalized_tracks() == []

    def test_issues_stable_identifiers(self, config, frame_ms):
        manager = TrackManager(config)
        run(manager, [[detection(0.40, x=0.1), detection(0.40, x=0.8)]], frame_ms)
        assert [t.local_track_id for t in manager.active_tracks] == ["track-001", "track-002"]


class TestTriggerRegion:
    def test_detects_entry_into_the_lower_band(self, config):
        top_y = config.trigger_region_top_y
        assert not is_in_trigger_region(BoundingBox(0.4, 0.50, 0.1, 0.1), top_y)
        assert is_in_trigger_region(BoundingBox(0.4, 0.80, 0.1, 0.1), top_y)

    def test_uses_the_centroid_not_the_edge(self, config):
        top_y = config.trigger_region_top_y
        # Bottom edge inside the zone, centroid still above it.
        assert not is_in_trigger_region(BoundingBox(0.4, 0.60, 0.1, 0.2), top_y)
