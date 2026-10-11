from __future__ import annotations

import uuid
from collections import defaultdict

from geoalchemy2.functions import ST_X, ST_Y, ST_DWithin, ST_SetSRID
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import VideoAnalysis, VideoAnalysisPothole

# An analysis and its latitude/longitude, both None while it has not been placed.
AnalysisRow = tuple[VideoAnalysis, float | None, float | None]


def _coordinates():
    geometry = func.ST_GeomFromWKB(VideoAnalysis.location)
    return ST_Y(geometry).label("latitude"), ST_X(geometry).label("longitude")


def _row(row) -> AnalysisRow:
    latitude, longitude = row[1], row[2]
    return (
        row[0],
        float(latitude) if latitude is not None else None,
        float(longitude) if longitude is not None else None,
    )


class VideoAnalysisRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get(self, analysis_id: uuid.UUID) -> AnalysisRow | None:
        latitude, longitude = _coordinates()
        row = (
            await self._session.execute(
                select(VideoAnalysis, latitude, longitude).where(VideoAnalysis.id == analysis_id)
            )
        ).first()
        return _row(row) if row is not None else None

    async def exists(self, analysis_id: uuid.UUID) -> bool:
        statement = select(VideoAnalysis.id).where(VideoAnalysis.id == analysis_id)
        return (await self._session.execute(statement)).first() is not None

    async def add_unless_exists(
        self, analysis: VideoAnalysis, potholes: list[VideoAnalysisPothole]
    ) -> bool:
        """Insert an analysis and its potholes; False if its id was already taken.

        The id is the client's, so two attempts of one create can race: a browser retrying
        before its first try answered. The loser's insert waits on the primary key until
        the winner commits, then fails; the savepoint confines that failure to this insert,
        and the caller reads the winner's row instead of answering 500.
        """
        try:
            async with self._session.begin_nested():
                self._session.add(analysis)
                # Flushed apart: there is no ORM relationship to order the inserts by.
                await self._session.flush()
                self._session.add_all(potholes)
                await self._session.flush()
        except IntegrityError:
            # Asked of the database, not the identity map, which may still hold the
            # object whose insert just failed.
            if not await self.exists(analysis.id):
                raise
            return False
        return True

    async def potholes(self, analysis_id: uuid.UUID) -> list[VideoAnalysisPothole]:
        """An analysis's potholes in the order the clip shows them."""
        rows = await self._session.execute(
            select(VideoAnalysisPothole)
            .where(VideoAnalysisPothole.analysis_id == analysis_id)
            .order_by(VideoAnalysisPothole.first_seen_seconds, VideoAnalysisPothole.track_id)
        )
        return list(rows.scalars().all())

    async def recent(self, limit: int) -> list[AnalysisRow]:
        latitude, longitude = _coordinates()
        rows = await self._session.execute(
            select(VideoAnalysis, latitude, longitude)
            .order_by(VideoAnalysis.created_at.desc(), VideoAnalysis.id.desc())
            .limit(limit)
        )
        return [_row(row) for row in rows.all()]

    async def severity_counts(
        self, analysis_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, dict[str, int]]:
        """Potholes per severity for each analysis; an analysis with none is absent."""
        if not analysis_ids:
            return {}
        rows = await self._session.execute(
            select(
                VideoAnalysisPothole.analysis_id,
                VideoAnalysisPothole.severity,
                func.count(),
            )
            .where(VideoAnalysisPothole.analysis_id.in_(analysis_ids))
            .group_by(VideoAnalysisPothole.analysis_id, VideoAnalysisPothole.severity)
        )
        counts: dict[uuid.UUID, dict[str, int]] = defaultdict(dict)
        for analysis_id, severity, total in rows.all():
            counts[analysis_id][severity] = int(total)
        return dict(counts)

    async def located_in_bbox(
        self,
        *,
        min_lng: float,
        min_lat: float,
        max_lng: float,
        max_lat: float,
        limit: int,
    ) -> list[tuple[VideoAnalysis, float, float]]:
        """Placed analyses inside a map viewport, newest first.

        The same envelope test as the potholes map, so it uses the GiST index the same way.
        """
        latitude, longitude = _coordinates()
        envelope = func.ST_GeogFromWKB(
            ST_SetSRID(func.ST_MakeEnvelope(min_lng, min_lat, max_lng, max_lat, 4326), 4326)
        )
        rows = await self._session.execute(
            select(VideoAnalysis, latitude, longitude)
            .where(VideoAnalysis.location.is_not(None))
            .where(ST_DWithin(VideoAnalysis.location, envelope, 0))
            .order_by(VideoAnalysis.created_at.desc(), VideoAnalysis.id.desc())
            .limit(limit)
        )
        return [(row[0], float(row[1]), float(row[2])) for row in rows.all()]

    async def thumbnail_keys(
        self, analysis_ids: list[uuid.UUID], per_analysis: int
    ) -> dict[uuid.UUID, list[str]]:
        """Up to `per_analysis` uploaded crop keys per analysis, worst pothole first."""
        if not analysis_ids:
            return {}
        rank = (
            func.row_number()
            .over(
                partition_by=VideoAnalysisPothole.analysis_id,
                order_by=(
                    VideoAnalysisPothole.severity_score.desc(),
                    VideoAnalysisPothole.confidence.desc(),
                    VideoAnalysisPothole.first_seen_seconds,
                    VideoAnalysisPothole.track_id,
                ),
            )
            .label("rank")
        )
        ranked = (
            select(VideoAnalysisPothole.analysis_id, VideoAnalysisPothole.crop_key, rank)
            .where(
                VideoAnalysisPothole.analysis_id.in_(analysis_ids),
                VideoAnalysisPothole.crop_key.is_not(None),
                VideoAnalysisPothole.crop_uploaded_at.is_not(None),
            )
            .subquery()
        )
        rows = await self._session.execute(
            select(ranked.c.analysis_id, ranked.c.crop_key)
            .where(ranked.c.rank <= per_analysis)
            .order_by(ranked.c.analysis_id, ranked.c.rank)
        )
        keys: dict[uuid.UUID, list[str]] = defaultdict(list)
        for analysis_id, crop_key in rows.all():
            keys[analysis_id].append(crop_key)
        return dict(keys)

    async def pothole_page(
        self, *, limit: int, offset: int
    ) -> list[tuple[VideoAnalysisPothole, str, bool]]:
        """Every analysis's potholes: newest analysis first, then in clip order.

        Each with its analysis's title and whether that analysis has been placed.
        """
        rows = await self._session.execute(
            select(
                VideoAnalysisPothole,
                VideoAnalysis.title,
                VideoAnalysis.location.is_not(None).label("located"),
            )
            .join(VideoAnalysis, VideoAnalysis.id == VideoAnalysisPothole.analysis_id)
            .order_by(
                VideoAnalysis.created_at.desc(),
                VideoAnalysis.id.desc(),
                VideoAnalysisPothole.first_seen_seconds,
                VideoAnalysisPothole.track_id,
            )
            .limit(limit)
            .offset(offset)
        )
        return [(row[0], row[1], bool(row[2])) for row in rows.all()]

    async def count_potholes(self) -> int:
        statement = select(func.count()).select_from(VideoAnalysisPothole)
        return int((await self._session.execute(statement)).scalar_one())
