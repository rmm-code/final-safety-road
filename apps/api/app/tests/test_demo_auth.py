"""The hackathon switch that serves the console without anyone signing in.

Disabling authentication is a business rule, so it is tested like one - including the
guard that stops it reaching production, which is the only part of this that matters
after the demo is over.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings, get_settings
from app.models import User

BBOX = "69.24,41.28,69.32,41.34"


def settings_with(**overrides) -> Settings:
    base = {
        "JWT_SECRET": "test-secret-that-is-long-enough-for-validation",
        "DATABASE_URL": get_settings().database_url,
    }
    # `_env_file=None`: built from what the test says and nothing on disk, so a developer's
    # local `.env` cannot decide whether "the default" is open or closed.
    return Settings(_env_file=None, **{**base, **overrides})  # type: ignore[arg-type]


# -- The production guard ------------------------------------------------------


def test_an_open_api_is_refused_in_production() -> None:
    """Raised at startup, not logged: a deployment that got this wrong must not boot."""
    with pytest.raises(ValueError, match="AUTH_DISABLED"):
        settings_with(AUTH_DISABLED=True, ENVIRONMENT="production")


def test_the_guard_also_catches_the_short_spelling() -> None:
    with pytest.raises(ValueError, match="AUTH_DISABLED"):
        settings_with(AUTH_DISABLED=True, ENVIRONMENT="prod")


def test_development_may_disable_auth() -> None:
    assert settings_with(AUTH_DISABLED=True, ENVIRONMENT="development").auth_disabled is True


def test_authentication_is_required_by_default() -> None:
    """The flag has to be asked for. Forgetting it leaves the API closed."""
    assert settings_with().auth_disabled is False


# -- The flag in effect --------------------------------------------------------


@pytest_asyncio.fixture
async def open_client(engine) -> AsyncIterator[AsyncClient]:
    """A client against an API with AUTH_DISABLED on and no token at all."""
    from app.api.deps import get_db
    from app.main import create_app

    application = create_app()
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def override_db() -> AsyncIterator[AsyncSession]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    application.dependency_overrides[get_db] = override_db
    application.dependency_overrides[get_settings] = lambda: settings_with(AUTH_DISABLED=True)

    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def test_an_unauthenticated_request_is_served(open_client: AsyncClient) -> None:
    response = await open_client.get("/api/v1/potholes", params={"bbox": BBOX})

    assert response.status_code == 200, response.text


async def test_an_operator_only_route_is_reachable(open_client: AsyncClient) -> None:
    """The stand-in has to clear `require_roles`, or the review queue stays unusable."""
    response = await open_client.get("/api/v1/citizen-reports/pending-count")

    assert response.status_code == 200, response.text


async def test_the_stand_in_is_a_real_row(open_client: AsyncClient, db: AsyncSession) -> None:
    """Drive sessions, status history and report reviews all record who acted, by id."""
    response = await open_client.get("/api/v1/auth/me")

    assert response.status_code == 200, response.text
    email = response.json()["email"]
    found = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    assert found is not None


async def test_the_stand_in_cannot_be_signed_into(open_client: AsyncClient) -> None:
    """Enabling the flag must not leave behind an account with a guessable password."""
    email = (await open_client.get("/api/v1/auth/me")).json()["email"]

    # Every candidate is at least 8 characters, because the login schema rejects shorter
    # ones with a 422 before any password is checked - which would pass this test while
    # proving nothing about the stored hash.
    for attempt in ("password", "demo-password", "demodemo", "12345678", email):
        response = await open_client.post(
            "/api/v1/auth/login", json={"email": email, "password": attempt}
        )
        assert response.status_code == 401


async def test_health_says_the_api_is_open(open_client: AsyncClient) -> None:
    """A demo and a real deployment must not look identical here."""
    assert (await open_client.get("/health")).json()["auth"] == "disabled"


async def test_health_says_the_api_is_closed_by_default(client: AsyncClient) -> None:
    assert (await client.get("/health")).json()["auth"] == "required"


async def test_a_closed_api_still_refuses(client: AsyncClient) -> None:
    """The ordinary fixture has the flag off; nothing about the real path changed."""
    response = await client.get("/api/v1/potholes", params={"bbox": BBOX})

    assert response.status_code == 401
