from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import Device, DriveSession
from app.repositories.events import DetectionEventRepository
from app.schemas.drive_session import DriveSessionCreate, DriveSessionEnd, DriveSessionOut

router = APIRouter(prefix="/drive-sessions", tags=["drive-sessions"])


@router.post("", response_model=DriveSessionOut, status_code=status.HTTP_201_CREATED)
async def create_drive_session(
    payload: DriveSessionCreate, db: DbDep, user: CurrentUser, response: Response
) -> DriveSessionOut:
    if payload.id is not None:
        existing = await db.get(DriveSession, payload.id)
        if existing is not None:
            if existing.user_id != user.id:
                # Never adopt someone else's drive by guessing its id.
                raise HTTPException(status.HTTP_409_CONFLICT, "Drive session id is taken")
            # The phone retrying a create it could not confirm. Same answer, no new row.
            response.status_code = status.HTTP_200_OK
            out = DriveSessionOut.model_validate(existing)
            out.event_count = await DetectionEventRepository(db).count_for_session(existing.id)
            return out

    device_id: uuid.UUID | None = None
    if payload.device_name:
        device = (
            await db.execute(
                select(Device).where(
                    Device.user_id == user.id, Device.device_name == payload.device_name
                )
            )
        ).scalar_one_or_none()
        if device is None:
            device = Device(
                user_id=user.id,
                device_name=payload.device_name,
                platform=payload.platform,
                browser=payload.browser,
            )
            db.add(device)
            await db.flush()
        device.last_seen_at = datetime.now(UTC)
        device_id = device.id

    session = DriveSession(user_id=user.id, device_id=device_id, status="active")
    if payload.id is not None:
        session.id = payload.id
    # The phone's clock, because a session created late - after a drive begun out of
    # signal - would otherwise start when the signal returned. Never in the future.
    if payload.started_at is not None:
        session.started_at = min(_as_utc(payload.started_at), datetime.now(UTC))
    db.add(session)
    await db.flush()
    return DriveSessionOut.model_validate(session)


@router.get("/{session_id}", response_model=DriveSessionOut)
async def get_drive_session(session_id: uuid.UUID, db: DbDep, user: CurrentUser) -> DriveSessionOut:
    session = await db.get(DriveSession, session_id)
    if session is None or (session.user_id != user.id and user.role not in {"admin", "operator"}):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Drive session not found")

    out = DriveSessionOut.model_validate(session)
    out.event_count = await DetectionEventRepository(db).count_for_session(session_id)
    return out


@router.post("/{session_id}/end", response_model=DriveSessionOut)
async def end_drive_session(
    session_id: uuid.UUID,
    db: DbDep,
    user: CurrentUser,
    payload: DriveSessionEnd | None = None,
) -> DriveSessionOut:
    session = await db.get(DriveSession, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Drive session not found")

    # Ending twice is not an error: a phone that lost signal mid-request will retry.
    if session.status == "active":
        now = datetime.now(UTC)
        reported = payload.ended_at if payload is not None else None
        session.status = "ended"
        # Clamped between the start and now: a phone's clock is evidence, not authority.
        session.ended_at = (
            max(min(_as_utc(reported), now), _as_utc(session.started_at)) if reported else now
        )

    out = DriveSessionOut.model_validate(session)
    out.event_count = await DetectionEventRepository(db).count_for_session(session_id)
    return out


def _as_utc(value: datetime) -> datetime:
    """A naive timestamp is taken as UTC, the only zone this API stores."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)
