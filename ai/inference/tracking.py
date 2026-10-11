"""IoU tracking with perspective-aware motion prediction.

Mirrors ``packages/vision-web/src/pipeline/track-manager.ts``. A pothole appears in many
consecutive frames; counting each frame as a new pothole would inflate results by an
order of magnitude, so association happens here and only confirmed tracks become events.
"""

from __future__ import annotations

from dataclasses import dataclass

from ai.inference.config import VisionConfig
from ai.inference.geometry import BoundingBox, iou, polygon_area
from ai.inference.types import Detection, DetectionObservation, PotholeTrack

# Apparent size can grow quickly, but never by more than this per prediction.
MAX_SCALE_GROWTH = 4.0
# A predicted centre never jumps more than this fraction of the frame.
MAX_CENTRE_SHIFT = 0.6


def is_in_trigger_region(box: BoundingBox, top_y: float) -> bool:
    """A pothole reaching the lower band of the frame is close to the vehicle."""
    return box.centre[1] >= top_y


def visible_area(detection: Detection) -> float:
    """Visible area of a detection, preferring the segmentation mask over the box.

    A bounding box around an irregular pothole overstates its area, and severity is
    driven by visible area. Where a model gives a mask, that is the better measurement;
    the box is the fallback.

    Note that mask areas are systematically smaller than box areas, so a segmentation
    model and a detection model will not produce identical severity scores from the same
    footage. `severity.areaScoreReference` is the knob for that, per model.
    """
    area = polygon_area(detection.polygon)
    return area if area > 0 else detection.bbox.area


@dataclass(slots=True)
class TrackUpdate:
    matched: list[PotholeTrack]
    created: list[PotholeTrack]
    closed: list[PotholeTrack]


@dataclass(frozen=True, slots=True)
class _CentreForm:
    cx: float
    cy: float
    width: float
    height: float


def _centre_form(box: BoundingBox) -> _CentreForm:
    return _CentreForm(box.x + box.width / 2, box.y + box.height / 2, box.width, box.height)


def _subtract(a: _CentreForm, b: _CentreForm) -> _CentreForm:
    return _CentreForm(a.cx - b.cx, a.cy - b.cy, a.width - b.width, a.height - b.height)


def _clamp_scale(predicted: float, current: float) -> float:
    return min(current * MAX_SCALE_GROWTH, max(current / MAX_SCALE_GROWTH, predicted))


def _clamp_shift(delta: float) -> float:
    return min(MAX_CENTRE_SHIFT, max(-MAX_CENTRE_SHIFT, delta))


class TrackManager:
    """Converts repeated per-frame detections into one local pothole track."""

    def __init__(self, config: VisionConfig, id_prefix: str = "track") -> None:
        self._config = config
        self._id_prefix = id_prefix
        self._next_id = 0
        self._tracks: list[PotholeTrack] = []
        self._finalized: list[PotholeTrack] = []
        self._rejected: list[PotholeTrack] = []

    @property
    def active_tracks(self) -> list[PotholeTrack]:
        return list(self._tracks)

    def update(
        self, detections: list[Detection], timestamp_ms: float, frame_index: int
    ) -> TrackUpdate:
        threshold = self._config.detection.confidence_threshold
        usable = [d for d in detections if d.confidence >= threshold and d.bbox.area > 0]

        pairs: list[tuple[float, int, int]] = []
        for track_index, track in enumerate(self._tracks):
            predicted = self._predict_box(track)
            for detection_index, detection in enumerate(usable):
                score = self._association_score(predicted, detection.bbox)
                if score is not None:
                    pairs.append((score, track_index, detection_index))

        # Greedy assignment, strongest match first.
        pairs.sort(key=lambda item: item[0], reverse=True)
        used_tracks: set[int] = set()
        used_detections: set[int] = set()
        matched: list[PotholeTrack] = []

        for _score, track_index, detection_index in pairs:
            if track_index in used_tracks or detection_index in used_detections:
                continue
            used_tracks.add(track_index)
            used_detections.add(detection_index)
            track = self._tracks[track_index]
            self._append_observation(track, usable[detection_index], timestamp_ms, frame_index)
            matched.append(track)

        created = [
            self._create_track(detection, timestamp_ms, frame_index)
            for index, detection in enumerate(usable)
            if index not in used_detections
        ]

        closed: list[PotholeTrack] = []
        survivors: list[PotholeTrack] = []
        for track_index, track in enumerate(self._tracks):
            if track_index in used_tracks:
                survivors.append(track)
                continue
            track.missed_frames += 1
            if track.missed_frames > self._config.tracking.max_missed_frames:
                self._close_track(track)
                closed.append(track)
            else:
                survivors.append(track)

        self._tracks = survivors + created
        return TrackUpdate(matched=matched, created=created, closed=closed)

    def flush(self) -> list[PotholeTrack]:
        """Close every remaining track at the end of the video."""
        closed = self._tracks
        for track in closed:
            self._close_track(track)
        self._tracks = []
        return closed

    def take_finalized_tracks(self) -> list[PotholeTrack]:
        out, self._finalized = self._finalized, []
        return out

    def take_rejected_tracks(self) -> list[PotholeTrack]:
        out, self._rejected = self._rejected, []
        return out

    def _association_score(self, predicted: BoundingBox, candidate: BoundingBox) -> float | None:
        """Match quality, or None when the detection does not belong to this track.

        Overlap is the primary signal. The proximity fallback exists because close to the
        vehicle a pothole can move further than its own height between analysed frames,
        at which point IoU is exactly zero however good the prediction was. Proximity
        matches always score below the IoU gate, so real overlap wins the assignment.
        """
        tracking = self._config.tracking
        overlap = iou(predicted, candidate)
        if overlap >= tracking.iou_match_threshold:
            return overlap
        if tracking.centre_distance_gate <= 0:
            return None
        if predicted.area <= 0 or candidate.area <= 0:
            return None

        ratio = candidate.area / predicted.area
        if ratio > tracking.scale_ratio_gate or ratio < 1 / tracking.scale_ratio_gate:
            return None

        px, py = predicted.centre
        cx, cy = candidate.centre
        distance = ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5
        radius = (
            (predicted.width**2 + predicted.height**2) ** 0.5
            + (candidate.width**2 + candidate.height**2) ** 0.5
        ) / 4
        if radius <= 0:
            return None

        normalised = distance / radius
        if normalised > tracking.centre_distance_gate:
            return None
        return (
            tracking.iou_match_threshold * 0.99 * (1 - normalised / tracking.centre_distance_gate)
        )

    def _predict_box(self, track: PotholeTrack) -> BoundingBox:
        """Where the track is expected to be, extrapolating centre and size.

        Under perspective, a pothole's row position and apparent size both accelerate as
        the vehicle closes in, so a constant-velocity model lags exactly where it matters
        most: at close range, where the largest and clearest observations are.
        """
        count = len(track.observations)
        last = track.observations[-1]
        if not self._config.tracking.motion_prediction or count < 2:
            return last.detection.bbox

        current = _centre_form(last.detection.bbox)
        before = _centre_form(track.observations[-2].detection.bbox)
        velocity = _subtract(current, before)

        acceleration = _CentreForm(0.0, 0.0, 0.0, 0.0)
        if count >= 3:
            earlier = _centre_form(track.observations[-3].detection.bbox)
            acceleration = _subtract(velocity, _subtract(before, earlier))

        steps = max(1, track.missed_frames + 1)
        ramped = steps * (steps + 1) / 2

        width = _clamp_scale(
            current.width + velocity.width * steps + acceleration.width * ramped, current.width
        )
        height = _clamp_scale(
            current.height + velocity.height * steps + acceleration.height * ramped, current.height
        )
        cx = current.cx + _clamp_shift(velocity.cx * steps + acceleration.cx * ramped)
        cy = current.cy + _clamp_shift(velocity.cy * steps + acceleration.cy * ramped)

        return BoundingBox(cx - width / 2, cy - height / 2, width, height)

    def _create_track(
        self, detection: Detection, timestamp_ms: float, frame_index: int
    ) -> PotholeTrack:
        self._next_id += 1
        return PotholeTrack(
            local_track_id=f"{self._id_prefix}-{self._next_id:03d}",
            state="CANDIDATE",
            first_seen_at=timestamp_ms,
            last_seen_at=timestamp_ms,
            max_confidence=detection.confidence,
            max_area=detection.bbox.area,
            observations=[self._to_observation(detection, timestamp_ms, frame_index)],
        )

    def _append_observation(
        self, track: PotholeTrack, detection: Detection, timestamp_ms: float, frame_index: int
    ) -> None:
        track.observations.append(self._to_observation(detection, timestamp_ms, frame_index))
        track.last_seen_at = timestamp_ms
        track.max_confidence = max(track.max_confidence, detection.confidence)
        track.max_area = max(track.max_area, detection.bbox.area)
        track.missed_frames = 0
        track.state = (
            "CONFIRMED"
            if self._meets_promotion_rules(track)
            else ("TRACKING" if len(track.observations) >= 2 else "CANDIDATE")
        )

    def _to_observation(
        self, detection: Detection, timestamp_ms: float, frame_index: int
    ) -> DetectionObservation:
        return DetectionObservation(
            timestamp_ms=timestamp_ms,
            frame_index=frame_index,
            detection=detection,
            area=visible_area(detection),
            in_trigger_region=is_in_trigger_region(
                detection.bbox, self._config.trigger_region_top_y
            ),
        )

    def _meets_promotion_rules(self, track: PotholeTrack) -> bool:
        tracking = self._config.tracking
        return (
            len(track.observations) >= tracking.min_observations
            and track.max_confidence >= tracking.min_max_confidence
            and track.last_seen_at - track.first_seen_at >= tracking.min_duration_ms
        )

    def _close_track(self, track: PotholeTrack) -> None:
        """Terminal transition.

        REJECTED_LOW_CONFIDENCE covers every promotion-rule failure (too few
        observations, too low a peak confidence, or too short a track): to the pipeline
        they are all "not enough evidence".
        """
        track.finalized = True
        if self._meets_promotion_rules(track):
            track.state = "FINALIZED"
            self._finalized.append(track)
        else:
            track.state = "REJECTED_LOW_CONFIDENCE"
            self._rejected.append(track)
