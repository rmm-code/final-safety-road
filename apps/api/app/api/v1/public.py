"""Unauthenticated routes that back the public map.

Everything here is readable by anyone with the URL, so each route is written from that
assumption rather than inheriting the internal API's models. The bounding box is capped
and the whole router is rate-limited separately from the authenticated API.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import DbDep, SettingsDep, public_rate_limit
from app.models import Pothole
from app.repositories.citizen_reports import CitizenReportRepository
from app.repositories.events import DetectionEventRepository
from app.repositories.potholes import PotholeRepository
from app.schemas.public import (
    VISIBLE_STATUSES,
    PublicConfig,
    PublicCounts,
    PublicPothole,
    PublicPotholeDetail,
    public_state,
)
from app.services.storage import ObjectStorage

router = APIRouter(
    prefix="/public", tags=["public"], dependencies=[Depends(public_rate_limit)]
)

# Tighter than the internal map's 5 degrees. A public caller has no reason to ask for a
# region larger than a metropolitan area, and the cap is what stops one request asking
# for the whole table.
MAX_PUBLIC_BBOX_SPAN_DEG = 1.0
MAX_PUBLIC_LIMIT = 3000


def _to_public(pothole: Pothole, latitude: float, longitude: float) -> PublicPothole | None:
    state = public_state(pothole.status)
    if state is None:
        return None
    return PublicPothole(
        id=pothole.id,
        latitude=latitude,
        longitude=longitude,
        state=state,
        severity=pothole.severity,  # type: ignore[arg-type]
        reported_count=pothole.sighting_count,
        first_seen_at=pothole.first_seen_at,
        last_seen_at=pothole.last_seen_at,
    )


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    try:
        min_lng, min_lat, max_lng, max_lat = (float(part) for part in bbox.split(","))
    except ValueError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "bbox must be minLng,minLat,maxLng,maxLat"
        ) from error

    if min_lng >= max_lng or min_lat >= max_lat:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "bbox is empty or inverted")
    if (
        max_lng - min_lng > MAX_PUBLIC_BBOX_SPAN_DEG
        or max_lat - min_lat > MAX_PUBLIC_BBOX_SPAN_DEG
    ):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"bbox may span at most {MAX_PUBLIC_BBOX_SPAN_DEG} degrees; zoom in",
        )
    return min_lng, min_lat, max_lng, max_lat


@router.get("/config", response_model=PublicConfig)
async def public_config(settings: SettingsDep) -> PublicConfig:
    """What the public page needs to render its report button.

    Served rather than baked into the frontend build so the bot can be renamed, or
    reporting turned off entirely, without redeploying the web app.
    """
    return PublicConfig(
        report_url=settings.report_deep_link,
        bot_username=settings.telegram_bot_username.lstrip("@"),
        confirmations_required=settings.citizen_confirmations_to_verify,
        telegram_enabled=settings.telegram_enabled,
    )


@router.get("/potholes", response_model=list[PublicPothole])
async def public_potholes(
    db: DbDep,
    bbox: str = Query(description="minLng,minLat,maxLng,maxLat"),
    state: str | None = Query(default=None, description="unverified, confirmed or fixed"),
    limit: int = Query(default=1500, ge=1, le=MAX_PUBLIC_LIMIT),
) -> list[PublicPothole]:
    min_lng, min_lat, max_lng, max_lat = _parse_bbox(bbox)

    wanted = {part.strip() for part in state.split(",")} if state else None
    rows = await PotholeRepository(db).in_bbox(
        min_lng=min_lng,
        min_lat=min_lat,
        max_lng=max_lng,
        max_lat=max_lat,
        # Filtering in the query, not after: statuses outside this tuple must never be
        # loaded, let alone serialised and dropped.
        statuses=VISIBLE_STATUSES,
        limit=limit,
    )

    out: list[PublicPothole] = []
    for pothole, latitude, longitude in rows:
        item = _to_public(pothole, latitude, longitude)
        if item is None:
            continue
        if wanted and item.state not in wanted:
            continue
        out.append(item)
    return out


@router.get("/counts", response_model=PublicCounts)
async def public_counts(
    db: DbDep,
    bbox: str = Query(description="minLng,minLat,maxLng,maxLat"),
) -> PublicCounts:
    """Totals for the summary card, over the same viewport as the markers."""
    min_lng, min_lat, max_lng, max_lat = _parse_bbox(bbox)
    rows = await PotholeRepository(db).in_bbox(
        min_lng=min_lng,
        min_lat=min_lat,
        max_lng=max_lng,
        max_lat=max_lat,
        statuses=VISIBLE_STATUSES,
        limit=MAX_PUBLIC_LIMIT,
    )

    tally = {"unverified": 0, "confirmed": 0, "fixed": 0}
    for pothole, _lat, _lng in rows:
        state = public_state(pothole.status)
        if state is not None:
            tally[state] += 1
    return PublicCounts(**tally, total=sum(tally.values()))


@router.get("/potholes/{pothole_id}", response_model=PublicPotholeDetail)
async def public_pothole(
    pothole_id: uuid.UUID, db: DbDep, settings: SettingsDep
) -> PublicPotholeDetail:
    found = await PotholeRepository(db).get(pothole_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    pothole, latitude, longitude = found
    base = _to_public(pothole, latitude, longitude)
    if base is None:
        # A pothole an operator archived or rejected is not "forbidden", it is not part
        # of the public map at all - and saying which would leak that it exists.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")

    # Which photo a stranger may see, in order:
    #   1. an operator-accepted citizen photo - a person chose that framing on purpose;
    #   2. our own detector's evidence CROP - road surface around the defect.
    #
    # Deliberately NOT `pothole.primary_image_key`. `attach_image` sets that to the first
    # photo a citizen sends when nothing better exists, so reading it here would publish an
    # unreviewed upload from a stranger - the one thing the review queue exists to stop.
    reports = CitizenReportRepository(db)
    image_key = await reports.public_image(
        pothole_id, require_review=settings.citizen_images_require_review
    )
    if image_key is None:
        image_key = await DetectionEventRepository(db).latest_crop_key(pothole_id)
    image_url: str | None = None
    if image_key:
        try:
            image_url = ObjectStorage(settings).presign_get(image_key)
        except Exception:
            # Storage being unreachable costs the photo, not the marker.
            image_url = None

    comment = None
    visible = await reports.for_pothole(
        pothole_id,
        states=("accepted",) if settings.citizen_images_require_review else ("accepted", "pending"),
        limit=1,
    )
    if visible:
        comment = visible[0].comment

    return PublicPotholeDetail(
        **base.model_dump(),
        location_accuracy_m=float(pothole.location_accuracy_m),
        comment=comment,
        image_url=image_url,
    )
