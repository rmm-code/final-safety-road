from __future__ import annotations

import uuid

from geoalchemy2.functions import ST_X, ST_Y
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DetectionEvent


class DetectionEventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def by_client_id(self, client_event_id: uuid.UUID) -> DetectionEvent | None:
        """Existing row for a client id, which is how retries stay idempotent."""
        return (
            await self._session.execute(
                select(DetectionEvent).where(DetectionEvent.client_event_id == client_event_id)
            )
        ).scalar_one_or_none()

    async def get(self, event_id: uuid.UUID) -> DetectionEvent | None:
        return await self._session.get(DetectionEvent, event_id)

    async def coordinates(self, event: DetectionEvent) -> tuple[float, float]:
        geometry = func.ST_GeomFromWKB(DetectionEvent.location)
        row = (
            await self._session.execute(
                select(ST_Y(geometry), ST_X(geometry)).where(DetectionEvent.id == event.id)
            )
        ).first()
        return (float(row[0]), float(row[1])) if row else (0.0, 0.0)

    async def count_for_session(self, drive_session_id: uuid.UUID) -> int:
        return int(
            (
                await self._session.execute(
                    select(func.count())
                    .select_from(DetectionEvent)
                    .where(DetectionEvent.drive_session_id == drive_session_id)
                )
            ).scalar_one()
        )

    async def latest_crop_key(self, pothole_id: uuid.UUID) -> str | None:
        """The newest evidence CROP our own detector stored for a pothole.

        Crops only, never `full_image_key`: a crop is the box around the defect - road
        surface - while a full frame is whatever the windscreen saw, pedestrians and
        number plates included. Only the first is fit for a public page.
        """
        return (
            await self._session.execute(
                select(DetectionEvent.crop_image_key)
                .where(
                    DetectionEvent.pothole_id == pothole_id,
                    DetectionEvent.crop_image_key.is_not(None),
                )
                .order_by(DetectionEvent.detected_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
