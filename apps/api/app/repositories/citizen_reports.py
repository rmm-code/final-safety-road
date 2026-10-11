from __future__ import annotations

import uuid

from geoalchemy2.functions import ST_X, ST_Y
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CitizenReport, Pothole


def report_location_columns():
    geometry = func.ST_GeomFromWKB(CitizenReport.location)
    return ST_Y(geometry).label("latitude"), ST_X(geometry).label("longitude")


class CitizenReportRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, report_id: uuid.UUID) -> tuple[CitizenReport, float, float] | None:
        latitude, longitude = report_location_columns()
        row = (
            await self._session.execute(
                select(CitizenReport, latitude, longitude).where(CitizenReport.id == report_id)
            )
        ).first()
        if row is None:
            return None
        return row[0], float(row[1]), float(row[2])

    async def queue(
        self,
        *,
        review_state: str | None = "pending",
        limit: int = 100,
        offset: int = 0,
    ) -> list[tuple[CitizenReport, float, float, Pothole | None]]:
        """Reports awaiting an operator, oldest first.

        Oldest first because the queue is work: a stack that serves the newest report
        first leaves the first person who ever wrote in waiting forever.
        """
        latitude, longitude = report_location_columns()
        statement = (
            select(CitizenReport, latitude, longitude, Pothole)
            .outerjoin(Pothole, Pothole.id == CitizenReport.pothole_id)
            .order_by(CitizenReport.created_at.asc())
            .limit(limit)
            .offset(offset)
        )
        if review_state:
            statement = statement.where(CitizenReport.review_state == review_state)

        rows = await self._session.execute(statement)
        return [(row[0], float(row[1]), float(row[2]), row[3]) for row in rows.all()]

    async def pending_count(self) -> int:
        return int(
            (
                await self._session.execute(
                    select(func.count(CitizenReport.id)).where(
                        CitizenReport.review_state == "pending"
                    )
                )
            ).scalar_one()
        )

    async def for_pothole(
        self, pothole_id: uuid.UUID, *, states: tuple[str, ...] | None = None, limit: int = 50
    ) -> list[CitizenReport]:
        statement = (
            select(CitizenReport)
            .where(CitizenReport.pothole_id == pothole_id)
            .order_by(CitizenReport.reported_at.desc())
            .limit(limit)
        )
        if states:
            statement = statement.where(CitizenReport.review_state.in_(states))
        return list((await self._session.execute(statement)).scalars().all())

    async def public_image(self, pothole_id: uuid.UUID, *, require_review: bool) -> str | None:
        """The photo a public visitor may see for this pothole.

        Only an ACCEPTED report's image by default. A public bot takes images from
        strangers; publishing them unreviewed would make this map a channel for whatever
        anyone chose to upload.
        """
        states = ("accepted",) if require_review else ("accepted", "pending")
        statement = (
            select(CitizenReport.image_key)
            .where(
                CitizenReport.pothole_id == pothole_id,
                CitizenReport.image_key.is_not(None),
                CitizenReport.review_state.in_(states),
            )
            .order_by(CitizenReport.reported_at.desc())
            .limit(1)
        )
        return (await self._session.execute(statement)).scalar_one_or_none()
