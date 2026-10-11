"""Deciding whether a sighting is a new pothole or another look at a known one.

A hundred cars driving the same street must not produce a hundred potholes. Equally, two
genuinely different defects five metres apart must not collapse into one. Everything here
exists to hold that line.

The scoring is deliberately separable from the database so it can be reasoned about and
tested directly: `score_candidate` is pure arithmetic over two positions.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

EARTH_RADIUS_M = 6_371_008.8


@dataclass(frozen=True, slots=True)
class CandidateScore:
    total: float
    distance_m: float
    distance_score: float
    heading_score: float
    severity_score: float
    recency_score: float

    @property
    def merges(self) -> bool:
        raise NotImplementedError  # threshold lives with the caller's settings


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def search_radius_m(accuracy_m: float, base_radius_m: float, max_radius_m: float) -> float:
    """How far to look for an existing pothole.

    A fix good to 4 m and a fix good to 40 m do not deserve the same search. Widening with
    reported accuracy is what stops a poor fix either missing its own pothole or, at the
    other extreme, swallowing every defect on the block.
    """
    return max(base_radius_m, min(max_radius_m, accuracy_m))


def heading_agreement(a: float | None, b: float | None) -> float:
    """1 for identical travel direction, 0 for opposing, 0.5 when unknown.

    Direction matters because the two carriageways of a road are metres apart: a defect
    seen heading north is usually not the one seen heading south.
    """
    if a is None or b is None:
        return 0.5
    difference = abs((a - b + 180) % 360 - 180)
    return max(0.0, 1.0 - difference / 180.0)


def severity_agreement(a: str, b: str) -> float:
    order = {"small": 0, "medium": 1, "large": 2}
    if a not in order or b not in order:
        return 0.5
    return max(0.0, 1.0 - abs(order[a] - order[b]) / 2)


def recency_score(last_seen_at: datetime, detected_at: datetime, half_life_days: float = 120.0) -> float:
    """Recently-confirmed potholes are likelier matches than long-dormant ones."""
    age_days = abs((detected_at - last_seen_at).total_seconds()) / 86_400
    return 0.5 ** (age_days / half_life_days)


def score_candidate(
    *,
    event_lat: float,
    event_lon: float,
    event_accuracy_m: float,
    event_heading_deg: float | None,
    event_severity: str,
    event_detected_at: datetime,
    pothole_lat: float,
    pothole_lon: float,
    pothole_heading_deg: float | None,
    pothole_severity: str,
    pothole_last_seen_at: datetime,
    base_radius_m: float,
    max_radius_m: float,
) -> CandidateScore:
    """How strongly a sighting matches one existing pothole, 0..1.

    Distance dominates, because it is the only signal that is always present and always
    meaningful. The rest adjust at the margins.
    """
    radius = search_radius_m(event_accuracy_m, base_radius_m, max_radius_m)
    distance = haversine_m(event_lat, event_lon, pothole_lat, pothole_lon)

    # Linear falloff to the search radius: at the edge of what we would even consider,
    # distance contributes nothing.
    distance_component = max(0.0, 1.0 - distance / radius) if radius > 0 else 0.0
    heading_component = heading_agreement(event_heading_deg, pothole_heading_deg)
    severity_component = severity_agreement(event_severity, pothole_severity)
    recency_component = recency_score(pothole_last_seen_at, event_detected_at)

    total = (
        0.65 * distance_component
        + 0.15 * heading_component
        + 0.10 * severity_component
        + 0.10 * recency_component
    )

    return CandidateScore(
        total=total,
        distance_m=distance,
        distance_score=distance_component,
        heading_score=heading_component,
        severity_score=severity_component,
        recency_score=recency_component,
    )


def merge_location(
    *,
    existing_lat: float,
    existing_lon: float,
    existing_accuracy_m: float,
    existing_sightings: int,
    new_lat: float,
    new_lon: float,
    new_accuracy_m: float,
) -> tuple[float, float, float]:
    """Fold a new sighting into a pothole's position estimate.

    Weighted by inverse accuracy: a fix good to 4 m should move the marker more than one
    good to 40 m. Repeated sightings therefore converge on the real location instead of
    drifting toward whichever car reported last.
    """
    existing_weight = existing_sightings / max(existing_accuracy_m, 1.0) ** 2
    new_weight = 1 / max(new_accuracy_m, 1.0) ** 2
    total = existing_weight + new_weight
    if total <= 0:
        return existing_lat, existing_lon, existing_accuracy_m

    lat = (existing_lat * existing_weight + new_lat * new_weight) / total
    lon = (existing_lon * existing_weight + new_lon * new_weight) / total
    # Never better than the best single fix. Sightings of one place are not independent
    # measurements - the same multipath, the same tall buildings, or literally the same
    # hand-dropped pin - so dividing by sqrt(n) manufactured precision. It also compounded:
    # `existing_accuracy_m` is already the merged figure, so six 100 m sightings of one pin
    # used to reach 3.7 m. The pothole's accuracy is therefore the best fix it has had.
    accuracy = max(min(existing_accuracy_m, new_accuracy_m), 1.0)
    return lat, lon, accuracy


def escalate_severity(current: str, incoming: str) -> str:
    """A pothole is as bad as the worst confident look anyone has had at it.

    Averaging would let a string of distant, small-looking sightings talk down a defect
    that one close pass showed to be severe.
    """
    order = {"unknown": -1, "small": 0, "medium": 1, "large": 2}
    return incoming if order.get(incoming, -1) > order.get(current, -1) else current
