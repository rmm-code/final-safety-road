"""Turning an uploaded sighting into a stored event and a physical pothole.

This is where the central data-model rule is enforced: a detection event is a sighting,
and it only becomes a new pothole when no existing one plausibly explains it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import DetectionEvent, Pothole, PotholeStatusHistory
from app.repositories.events import DetectionEventRepository
from app.repositories.potholes import PotholeRepository, point
from app.schemas.detection import DetectionEventCreate
from app.services.dedup import (
    escalate_severity,
    merge_location,
    score_candidate,
    search_radius_m,
)


@dataclass(slots=True)
class IngestResult:
    event: DetectionEvent
    pothole: Pothole
    latitude: float
    longitude: float
    deduplicated: bool
    created_pothole: bool
    already_ingested: bool


class IngestService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._events = DetectionEventRepository(session)
        self._potholes = PotholeRepository(session)

    async def ingest(self, payload: DetectionEventCreate) -> IngestResult:
        existing = await self._events.by_client_id(payload.client_event_id)
        if existing is not None:
            # A retry after an ambiguous failure. Returning the original row is what keeps
            # one physical pothole from becoming two because a phone lost signal mid-POST.
            pothole = (
                await self._session.get(Pothole, existing.pothole_id)
                if existing.pothole_id
                else None
            )
            latitude, longitude = await self._events.coordinates(existing)
            if pothole is None:
                pothole = await self._create_pothole(payload)
                existing.pothole_id = pothole.id
            return IngestResult(
                event=existing,
                pothole=pothole,
                latitude=latitude,
                longitude=longitude,
                deduplicated=True,
                created_pothole=False,
                already_ingested=True,
            )

        pothole, deduplicated = await self._resolve_pothole(payload)

        event = DetectionEvent(
            client_event_id=payload.client_event_id,
            drive_session_id=payload.drive_session_id,
            pothole_id=pothole.id,
            location=point(payload.latitude, payload.longitude),
            location_accuracy_m=payload.location_accuracy_m,
            location_source=payload.location_source,
            detected_at=payload.detected_at,
            confidence=payload.confidence,
            severity=payload.severity,
            severity_score=payload.severity_score,
            severity_confidence=payload.severity_confidence,
            heading_deg=payload.heading_deg,
            speed_mps=payload.speed_mps,
            model_version=payload.model_version,
            event_metadata=payload.metadata,
        )
        self._session.add(event)
        await self._session.flush()

        return IngestResult(
            event=event,
            pothole=pothole,
            latitude=payload.latitude,
            longitude=payload.longitude,
            deduplicated=deduplicated,
            created_pothole=not deduplicated,
            already_ingested=False,
        )

    async def _resolve_pothole(self, payload: DetectionEventCreate) -> tuple[Pothole, bool]:
        radius = search_radius_m(
            payload.location_accuracy_m,
            self._settings.dedup_radius_m,
            self._settings.dedup_max_radius_m,
        )
        candidates = await self._potholes.nearby(
            latitude=payload.latitude, longitude=payload.longitude, radius_m=radius
        )

        best: tuple[Pothole, float, float, float] | None = None
        for pothole, latitude, longitude in candidates:
            score = score_candidate(
                event_lat=payload.latitude,
                event_lon=payload.longitude,
                event_accuracy_m=payload.location_accuracy_m,
                event_heading_deg=payload.heading_deg,
                event_severity=payload.severity,
                event_detected_at=payload.detected_at,
                pothole_lat=latitude,
                pothole_lon=longitude,
                # Heading is not stored per pothole yet; the sighting history carries it.
                pothole_heading_deg=None,
                pothole_severity=pothole.severity,
                pothole_last_seen_at=pothole.last_seen_at,
                base_radius_m=self._settings.dedup_radius_m,
                max_radius_m=self._settings.dedup_max_radius_m,
            )
            if best is None or score.total > best[3]:
                best = (pothole, latitude, longitude, score.total)

        if best and best[3] >= self._settings.dedup_merge_threshold:
            await self._merge(best[0], best[1], best[2], payload)
            return best[0], True

        return await self._create_pothole(payload), False

    async def _merge(
        self, pothole: Pothole, latitude: float, longitude: float, payload: DetectionEventCreate
    ) -> None:
        new_lat, new_lon, accuracy = merge_location(
            existing_lat=latitude,
            existing_lon=longitude,
            existing_accuracy_m=float(pothole.location_accuracy_m),
            existing_sightings=pothole.sighting_count,
            new_lat=payload.latitude,
            new_lon=payload.longitude,
            new_accuracy_m=payload.location_accuracy_m,
        )

        pothole.location = point(new_lat, new_lon)
        pothole.location_accuracy_m = accuracy
        pothole.sighting_count += 1
        pothole.severity = escalate_severity(pothole.severity, payload.severity)
        pothole.severity_score = max(float(pothole.severity_score), payload.severity_score)
        if payload.detected_at > pothole.last_seen_at:
            pothole.last_seen_at = payload.detected_at
        if payload.detected_at < pothole.first_seen_at:
            pothole.first_seen_at = payload.detected_at
        # A defect reported again is evidently not repaired.
        if pothole.status == "suspected_repaired":
            self._set_status(pothole, "active", reason="detected again after suspected repair")
        # Our own detector corroborating a member of the public IS the verification the
        # "reported" status is waiting for: there are evidence frames now, not one
        # stranger's word.
        elif pothole.status == "reported":
            self._set_status(
                pothole, "active", reason=f"confirmed by detector {payload.model_version}"
            )

    def _set_status(self, pothole: Pothole, new_status: str, *, reason: str) -> None:
        """Change status and write the history row that explains it."""
        if pothole.status == new_status:
            return
        self._session.add(
            PotholeStatusHistory(
                pothole_id=pothole.id,
                old_status=pothole.status,
                new_status=new_status,
                reason=reason,
                changed_by=None,
            )
        )
        pothole.status = new_status

    async def _create_pothole(self, payload: DetectionEventCreate) -> Pothole:
        pothole = Pothole(
            location=point(payload.latitude, payload.longitude),
            location_accuracy_m=payload.location_accuracy_m,
            severity=payload.severity,
            severity_score=payload.severity_score,
            status="active",
            first_seen_at=payload.detected_at,
            last_seen_at=payload.detected_at,
            sighting_count=1,
        )
        self._session.add(pothole)
        await self._session.flush()
        return pothole

    async def attach_image_keys(
        self, event: DetectionEvent, *, full_key: str | None, crop_key: str | None
    ) -> None:
        if full_key:
            event.full_image_key = full_key
        if crop_key:
            event.crop_image_key = crop_key
            pothole = await self._session.get(Pothole, event.pothole_id) if event.pothole_id else None
            # The newest clear crop becomes the pothole's face on the map.
            if pothole is not None and pothole.primary_image_key is None:
                pothole.primary_image_key = crop_key


def new_event_id() -> uuid.UUID:
    return uuid.uuid4()
