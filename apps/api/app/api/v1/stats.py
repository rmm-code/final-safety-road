from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbDep
from app.models import DetectionEvent, DriveSession, Pothole
from app.schemas.pothole import StatsOverview

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("/overview", response_model=StatsOverview)
async def overview(db: DbDep, _user: CurrentUser) -> StatsOverview:
    """Counts for the operations dashboard."""
    since = datetime.now(UTC) - timedelta(days=1)

    async def count(statement) -> int:
        return int((await db.execute(statement)).scalar_one())

    active = select(func.count()).select_from(Pothole).where(Pothole.status == "active")

    return StatsOverview(
        active_potholes=await count(active),
        large=await count(active.where(Pothole.severity == "large")),
        medium=await count(active.where(Pothole.severity == "medium")),
        small=await count(active.where(Pothole.severity == "small")),
        new_today=await count(
            select(func.count()).select_from(Pothole).where(Pothole.created_at >= since)
        ),
        sightings_today=await count(
            select(func.count()).select_from(DetectionEvent).where(DetectionEvent.detected_at >= since)
        ),
        drive_sessions=await count(select(func.count()).select_from(DriveSession)),
        total_sightings=await count(select(func.count()).select_from(DetectionEvent)),
    )
