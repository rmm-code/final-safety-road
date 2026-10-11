"""Integration test fixtures.

These run against a real PostGIS database, not a fake. Deduplication and the map queries
are PostGIS behaviour; testing them against SQLite would test something else entirely and
prove nothing about production.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

os.environ.setdefault("JWT_SECRET", "test-secret-that-is-long-enough-for-validation")
os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://pothole:pothole@localhost:5433/pothole_test"
)
# An obviously-fake bot token, shaped like a real one. Telegram integration is off unless
# a token is configured, so without this every Telegram route would answer 503 and the
# tests would assert nothing. Never a real token: `sign_init_data` needs the same secret
# the verifier uses, and a real one in the repository is a leaked credential.
TEST_BOT_TOKEN = "123456:TEST-BOT-TOKEN-not-a-real-credential"
os.environ.setdefault("TELEGRAM_BOT_TOKEN", TEST_BOT_TOKEN)
os.environ.setdefault("TELEGRAM_BOT_USERNAME", "test_pothole_bot")
os.environ.setdefault("TELEGRAM_WEBHOOK_SECRET", "webhook-secret-for-tests")
# Pinned, not defaulted from the developer's machine. `Settings` reads a local `.env`, and
# a hackathon checkout has `AUTH_DISABLED=true` in one - an environment variable outranks
# the dotenv file, so this keeps every test asserting the closed API actually testing it.
os.environ["AUTH_DISABLED"] = "false"

from app.core.config import get_settings  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.models import User  # noqa: E402


@pytest_asyncio.fixture(scope="session")
async def engine():
    settings = get_settings()
    admin_url = settings.database_url.rsplit("/", 1)[0] + "/postgres"
    admin = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    database = settings.database_url.rsplit("/", 1)[1]

    async with admin.connect() as connection:
        await connection.exec_driver_sql(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
        await connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    await admin.dispose()

    engine = create_async_engine(settings.database_url, future=True)
    async with engine.begin() as connection:
        await connection.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS postgis")
        # The models declare the GiST indexes themselves, so create_all builds them:
        # spatial queries are indexed here exactly as they are in production.
        await connection.run_sync(Base.metadata.create_all)
    yield engine
    await engine.dispose()


@pytest_asyncio.fixture
async def db(engine) -> AsyncIterator[AsyncSession]:
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
        await session.rollback()


@pytest_asyncio.fixture(autouse=True)
async def clean(engine):
    """Each test starts from an empty database, so ordering can never matter."""
    from app.core.limiter import limiter

    # The limiter is process-global and every in-process request comes from one client
    # address, so without this a test's 429 would depend on how many requests the tests
    # before it happened to make in the last minute.
    limiter.reset()
    yield
    async with engine.begin() as connection:
        await connection.exec_driver_sql(
            "TRUNCATE video_analysis_potholes, video_analyses, "
            "citizen_reports, telegram_report_drafts, detection_events, "
            "pothole_status_history, potholes, drive_sessions, devices, users "
            "RESTART IDENTITY CASCADE"
        )


@pytest_asyncio.fixture
async def client(engine) -> AsyncIterator[AsyncClient]:
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
    transport = ASGITransport(app=application)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


@pytest_asyncio.fixture
async def driver(db: AsyncSession) -> User:
    user = User(
        id=uuid.uuid4(),
        email="driver@example.com",
        name="Test Driver",
        role="driver",
        password_hash=hash_password("correct-horse"),
    )
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def operator(db: AsyncSession) -> User:
    user = User(
        id=uuid.uuid4(),
        email="operator@example.com",
        name="Test Operator",
        role="operator",
        password_hash=hash_password("correct-horse"),
    )
    db.add(user)
    await db.commit()
    return user


@pytest_asyncio.fixture
async def auth(client: AsyncClient, driver: User) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login", json={"email": driver.email, "password": "correct-horse"}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest_asyncio.fixture
async def operator_auth(client: AsyncClient, operator: User) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login", json={"email": operator.email, "password": "correct-horse"}
    )
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest_asyncio.fixture
async def other_auth(client: AsyncClient, db: AsyncSession) -> dict[str, str]:
    """A second ordinary driver."""
    db.add(
        User(
            email="other-driver@example.com",
            name="Other Driver",
            role="driver",
            password_hash=hash_password("correct-horse"),
        )
    )
    await db.commit()
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "other-driver@example.com", "password": "correct-horse"},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


@pytest_asyncio.fixture
async def drive_session_id(client: AsyncClient, auth: dict[str, str]) -> str:
    response = await client.post("/api/v1/drive-sessions", json={}, headers=auth)
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.fixture
def settings():
    return get_settings()


@pytest.fixture
def bot_token() -> str:
    return TEST_BOT_TOKEN
