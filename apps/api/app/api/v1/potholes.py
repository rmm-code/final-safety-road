from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import CurrentUser, DbDep, SettingsDep, require_roles
from app.core.config import Settings
from app.models import Pothole, PotholeStatusHistory, User
from app.repositories.potholes import PotholeRepository
from app.schemas.pothole import (
    PotholeDetail,
    PotholeObservation,
    PotholeOut,
    PotholePatch,
    PotholeReview,
    PotholeStatusUpdate,
)
from app.services.storage import ObjectStorage

router = APIRouter(prefix="/potholes", tags=["potholes"])

MAX_BBOX_SPAN_DEG = 5.0


def _to_out(pothole: Pothole, latitude: float, longitude: float) -> PotholeOut:
    return PotholeOut(
        id=pothole.id,
        latitude=latitude,
        longitude=longitude,
        location_accuracy_m=float(pothole.location_accuracy_m),
        severity=pothole.severity,  # type: ignore[arg-type]
        severity_score=float(pothole.severity_score),
        status=pothole.status,  # type: ignore[arg-type]
        first_seen_at=pothole.first_seen_at,
        last_seen_at=pothole.last_seen_at,
        sighting_count=pothole.sighting_count,
        primary_image_key=pothole.primary_image_key,
        road_name=pothole.road_name,
        reviewed_at=pothole.reviewed_at,
        review_verdict=pothole.review_verdict,  # type: ignore[arg-type]
    )


def _signed(settings: Settings, key: str | None) -> str | None:
    """A read link for one stored image, or nothing.

    Signing is local arithmetic, so it costs no round trip - but a misconfigured storage
    endpoint must cost the picture, never the page.
    """
    if not key:
        return None
    try:
        return ObjectStorage(settings).presign_get(key)
    except Exception:
        return None


@router.get("", response_model=list[PotholeOut])
async def list_potholes(
    db: DbDep,
    _user: CurrentUser,
    bbox: str = Query(description="minLng,minLat,maxLng,maxLat"),
    severity: str | None = Query(default=None, description="Comma-separated severities"),
    pothole_status: str | None = Query(default=None, alias="status"),
    seen_after: datetime | None = None,
    seen_before: datetime | None = None,
    min_sightings: int | None = Query(default=None, ge=1),
    reviewed: bool | None = Query(default=None, description="Only reviewed, or only not"),
    order: str = Query(default="recent", pattern="^(recent|severity)$"),
    limit: int = Query(default=2000, ge=1, le=5000),
) -> list[PotholeOut]:
    """Potholes inside a map viewport.

    A bounding box is required, and its span is capped: without that, panning out to the
    whole world would ask the database for every row it has.
    """
    try:
        min_lng, min_lat, max_lng, max_lat = (float(part) for part in bbox.split(","))
    except ValueError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "bbox must be minLng,minLat,maxLng,maxLat"
        ) from error

    if min_lng >= max_lng or min_lat >= max_lat:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "bbox is empty or inverted")
    if (max_lng - min_lng) > MAX_BBOX_SPAN_DEG or (max_lat - min_lat) > MAX_BBOX_SPAN_DEG:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"bbox may span at most {MAX_BBOX_SPAN_DEG} degrees; zoom in",
        )

    rows = await PotholeRepository(db).in_bbox(
        min_lng=min_lng,
        min_lat=min_lat,
        max_lng=max_lng,
        max_lat=max_lat,
        statuses=tuple(pothole_status.split(",")) if pothole_status else None,
        severities=tuple(severity.split(",")) if severity else None,
        seen_after=seen_after,
        seen_before=seen_before,
        min_sightings=min_sightings,
        reviewed=reviewed,
        order=order,
        limit=limit,
    )
    return [_to_out(pothole, latitude, longitude) for pothole, latitude, longitude in rows]


@router.get("/{pothole_id}", response_model=PotholeDetail)
async def get_pothole(
    pothole_id: uuid.UUID, db: DbDep, _user: CurrentUser, settings: SettingsDep
) -> PotholeDetail:
    repository = PotholeRepository(db)
    found = await repository.get(pothole_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pothole not found")

    pothole, latitude, longitude = found
    observations = await repository.observations(pothole_id)

    return PotholeDetail(
        **_to_out(pothole, latitude, longitude).model_dump(),
        primary_image_url=_signed(settings, pothole.primary_image_key),
        observations=[
            PotholeObservation(
                id=event.id,
                detected_at=event.detected_at,
                confidence=float(event.confidence),
                severity=event.severity,  # type: ignore[arg-type]
                model_version=event.model_version,
                location_accuracy_m=float(event.location_accuracy_m),
                location_source=event.location_source,  # type: ignore[arg-type]
                crop_image_key=event.crop_image_key,
                full_image_key=event.full_image_key,
                crop_image_url=_signed(settings, event.crop_image_key),
                full_image_url=_signed(settings, event.full_image_key),
            )
            for event in observations
        ],
    )


@router.patch("/{pothole_id}", response_model=PotholeOut)
async def patch_pothole(
    pothole_id: uuid.UUID,
    payload: PotholePatch,
    db: DbDep,
    _user: User = Depends(require_roles("admin", "operator")),
) -> PotholeOut:
    found = await PotholeRepository(db).get(pothole_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pothole not found")

    pothole, latitude, longitude = found
    if payload.road_name is not None:
        pothole.road_name = payload.road_name
    if payload.road_segment_id is not None:
        pothole.road_segment_id = payload.road_segment_id
    return _to_out(pothole, latitude, longitude)


@router.post("/{pothole_id}/status", response_model=PotholeOut)
async def set_pothole_status(
    pothole_id: uuid.UUID,
    payload: PotholeStatusUpdate,
    db: DbDep,
    user: User = Depends(require_roles("admin", "operator")),
) -> PotholeOut:
    """Change a pothole's status, recording who did it and why."""
    found = await PotholeRepository(db).get(pothole_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pothole not found")

    pothole, latitude, longitude = found
    if pothole.status != payload.status:
        db.add(
            PotholeStatusHistory(
                pothole_id=pothole.id,
                old_status=pothole.status,
                new_status=payload.status,
                reason=payload.reason,
                changed_by=user.id,
            )
        )
        pothole.status = payload.status

    return _to_out(pothole, latitude, longitude)


@router.post("/{pothole_id}/review", response_model=PotholeOut)
async def review_pothole(
    pothole_id: uuid.UUID,
    payload: PotholeReview,
    db: DbDep,
    user: User = Depends(require_roles("admin", "operator")),
) -> PotholeOut:
    """Record whether the detector was right about this pothole.

    "correct" leaves the status alone - a real pothole stays active until it is repaired.
    "false_positive" also retires it from the map, with a status-history row like any
    other status change. Either way the verdict is kept, so the pothole leaves the review
    queue and the decision can label training data later.
    """
    found = await PotholeRepository(db).get(pothole_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Pothole not found")

    pothole, latitude, longitude = found
    if payload.verdict == "false_positive" and pothole.status != "false_positive":
        db.add(
            PotholeStatusHistory(
                pothole_id=pothole.id,
                old_status=pothole.status,
                new_status="false_positive",
                reason=payload.note or "Marked false positive in review",
                changed_by=user.id,
            )
        )
        pothole.status = "false_positive"

    pothole.review_verdict = payload.verdict
    pothole.reviewed_at = datetime.now(UTC)
    pothole.reviewed_by = user.id
    return _to_out(pothole, latitude, longitude)
