"""Shared request dependencies: settings, database session, authenticated user."""

from __future__ import annotations

import secrets
import uuid
from collections.abc import AsyncIterator
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, get_settings
from app.core.security import decode_access_token, hash_password
from app.db.session import get_session_factory
from app.models import User

bearer_scheme = HTTPBearer(auto_error=False)

SettingsDep = Annotated[Settings, Depends(get_settings)]


async def get_db(settings: SettingsDep) -> AsyncIterator[AsyncSession]:
    factory = get_session_factory(settings)
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


DbDep = Annotated[AsyncSession, Depends(get_db)]


async def demo_user(db: AsyncSession, settings: Settings) -> User:
    """The account unauthenticated requests act as while AUTH_DISABLED is on.

    A real row, not a fabricated object: `DriveSession.user_id`,
    `PotholeStatusHistory.changed_by` and `CitizenReport.reviewed_by` are foreign keys,
    and a demo that cannot end a drive or accept a report is not a demo.

    Created with a random password nobody holds, so enabling the flag never creates an
    account that can also be signed into afterwards. An existing account with this
    address is used as it stands - its role is never raised.
    """
    email = settings.demo_user_email.lower()
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is not None:
        return user

    # A first page load fires several API calls at once, and on a fresh database each of
    # them finds no demo user. The savepoint lets the losers of that race hit the unique
    # constraint, roll back only their own insert, and read the winner's row - instead of
    # a flash of 500s the first time anyone opens the dashboard.
    try:
        async with db.begin_nested():
            user = User(
                email=email,
                name="Demo",
                role="admin",
                password_hash=hash_password(secrets.token_urlsafe(32)),
            )
            db.add(user)
        return user
    except IntegrityError:
        return (await db.execute(select(User).where(User.email == email))).scalar_one()


async def current_user(
    settings: SettingsDep,
    db: DbDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> User:
    if credentials is None:
        # Demo mode. Deliberately placed so a presented token is still verified normally:
        # the flag decides what happens when NOTHING is presented, and changes nothing
        # about the real path. `require_roles` still runs on whatever comes back.
        if settings.auth_disabled:
            return await demo_user(db, settings)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required")
    try:
        payload = decode_access_token(settings, credentials.credentials)
        user_id = uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError) as error:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from error

    user = await db.get(User, user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account is not active")
    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_roles(*roles: str):
    """Guard a route by role. Ordinary drivers may record, not curate."""

    async def guard(user: CurrentUser) -> User:
        if user.role not in roles:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"This action requires one of: {', '.join(roles)}"
            )
        return user

    return guard


async def rate_limit(request: Request, settings: SettingsDep) -> None:
    """Coarse per-IP request cap.

    Deliberately in-process and approximate: it exists to stop a runaway client, not to
    survive a distributed attack. A shared limiter arrives with Redis, when there is a
    reason for Redis.
    """
    from app.core.limiter import limiter

    identity = request.client.host if request.client else "unknown"
    if not limiter.allow(identity, settings.rate_limit_per_minute):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests")


async def public_rate_limit(request: Request, settings: SettingsDep) -> None:
    """The cap for unauthenticated routes.

    Separate and much tighter than `rate_limit`: the authenticated limit is sized for a
    fleet of phones uploading sightings, and applying that allowance to a route anyone on
    the internet can call would size the public map's budget by the drivers' needs.

    Keyed separately too, so a burst against the public map cannot exhaust the allowance
    of an authenticated client behind the same NAT.
    """
    from app.core.limiter import limiter

    identity = request.client.host if request.client else "unknown"
    if not limiter.allow(f"public:{identity}", settings.public_rate_limit_per_minute):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many requests")
