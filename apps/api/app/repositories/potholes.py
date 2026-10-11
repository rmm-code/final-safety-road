from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2.functions import ST_X, ST_Y, ST_DWithin, ST_MakePoint, ST_SetSRID
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DetectionEvent, Pothole


def point(latitude: float, longitude: float):
    """A WGS84 geography point. Longitude first - PostGIS takes X then Y."""
    return func.ST_GeogFromWKB(ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))


def location_columns():
    geometry = func.ST_GeomFromWKB(Pothole.location)
    return ST_Y(geometry).label("latitude"), ST_X(geometry).label("longitude")


class PotholeRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def nearby(
        self,
        *,
        latitude: float,
        longitude: float,
        radius_m: float,
        statuses: tuple[str, ...] = ("reported", "active", "suspected_repaired"),
        limit: int = 25,
    ) -> list[tuple[Pothole, float, float]]:
        """Candidate potholes within `radius_m`.

        `ST_DWithin` on a geography column uses the GiST index and measures in metres,
        which is what makes this fast enough to run on every uploaded sighting.
        """
        origin = point(latitude, longitude)
        latitude_col, longitude_col = location_columns()

        statement = (
            select(Pothole, latitude_col, longitude_col)
            .where(ST_DWithin(Pothole.location, origin, radius_m))
            .where(Pothole.status.in_(statuses))
            .order_by(func.ST_Distance(Pothole.location, origin))
            .limit(limit)
        )
        rows = await self._session.execute(statement)
        return [(row[0], float(row[1]), float(row[2])) for row in rows.all()]

    async def in_bbox(
        self,
        *,
        min_lng: float,
        min_lat: float,
        max_lng: float,
        max_lat: float,
        statuses: tuple[str, ...] | None = None,
        severities: tuple[str, ...] | None = None,
        seen_after: datetime | None = None,
        seen_before: datetime | None = None,
        min_sightings: int | None = None,
        reviewed: bool | None = None,
        order: str = "recent",
        limit: int = 2000,
    ) -> list[tuple[Pothole, float, float]]:
        """Potholes inside a map viewport, with the filters the map UI offers.

        `order="severity"` puts the worst first, which is the order a repair crew works in.
        """
        latitude_col, longitude_col = location_columns()
        envelope = func.ST_GeogFromWKB(
            ST_SetSRID(func.ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326), 4326)
        )

        statement: Select = select(Pothole, latitude_col, longitude_col).where(
            ST_DWithin(Pothole.location, envelope, 0)
        )
        if statuses:
            statement = statement.where(Pothole.status.in_(statuses))
        if severities:
            statement = statement.where(Pothole.severity.in_(severities))
        if seen_after:
            statement = statement.where(Pothole.last_seen_at >= seen_after)
        if seen_before:
            statement = statement.where(Pothole.last_seen_at <= seen_before)
        if min_sightings:
            statement = statement.where(Pothole.sighting_count >= min_sightings)
        if reviewed is not None:
            statement = statement.where(
                Pothole.reviewed_at.is_not(None) if reviewed else Pothole.reviewed_at.is_(None)
            )

        ordering = (
            (Pothole.severity_score.desc(), Pothole.last_seen_at.desc())
            if order == "severity"
            else (Pothole.last_seen_at.desc(),)
        )
        rows = await self._session.execute(statement.order_by(*ordering).limit(limit))
        return [(row[0], float(row[1]), float(row[2])) for row in rows.all()]

    async def get(self, pothole_id: uuid.UUID) -> tuple[Pothole, float, float] | None:
        latitude_col, longitude_col = location_columns()
        row = (
            await self._session.execute(
                select(Pothole, latitude_col, longitude_col).where(Pothole.id == pothole_id)
            )
        ).first()
        if row is None:
            return None
        return row[0], float(row[1]), float(row[2])

    async def observations(self, pothole_id: uuid.UUID, limit: int = 200) -> list[DetectionEvent]:
        rows = await self._session.execute(
            select(DetectionEvent)
            .where(DetectionEvent.pothole_id == pothole_id)
            .order_by(DetectionEvent.detected_at.desc())
            .limit(limit)
        )
        return list(rows.scalars().all())
