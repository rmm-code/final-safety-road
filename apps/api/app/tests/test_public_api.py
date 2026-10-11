"""The unauthenticated map.

Everything these routes return is world-readable, so the tests are mostly about what does
NOT come out: internal statuses, reporter identities, or a bounding box big enough to ask
for the whole table.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CitizenReport, DetectionEvent, DriveSession, Pothole, User
from app.repositories.potholes import point

LAT, LON = 41.3112, 69.2797
BBOX = "69.24,41.28,69.32,41.34"


async def make_pothole(db: AsyncSession, status: str, *, lat: float = LAT, lon: float = LON):
    now = datetime.now(UTC)
    pothole = Pothole(
        location=point(lat, lon),
        location_accuracy_m=8.0,
        severity="medium",
        severity_score=0.4,
        status=status,
        first_seen_at=now,
        last_seen_at=now,
        sighting_count=1,
    )
    db.add(pothole)
    await db.commit()
    return pothole


@pytest.mark.parametrize(
    ("status", "state"),
    [
        ("reported", "unverified"),  # purple: one person said so
        ("active", "confirmed"),  # red: corroborated, not fixed
        ("suspected_repaired", "confirmed"),  # still red; the repair is a guess
        ("repaired", "fixed"),  # green
    ],
)
async def test_internal_statuses_map_to_the_three_public_states(
    client: AsyncClient, db: AsyncSession, status: str, state: str
) -> None:
    await make_pothole(db, status)

    response = await client.get("/api/v1/public/potholes", params={"bbox": BBOX})

    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body) == 1
    assert body[0]["state"] == state
    assert "status" not in body[0], "internal vocabulary stays internal"


@pytest.mark.parametrize("status", ["false_positive", "ignored", "archived"])
async def test_potholes_an_operator_dismissed_are_not_published(
    client: AsyncClient, db: AsyncSession, status: str
) -> None:
    """Absent from the mapping means absent from the map - never defaulted to visible."""
    await make_pothole(db, status)

    response = await client.get("/api/v1/public/potholes", params={"bbox": BBOX})

    assert response.json() == []


async def test_a_dismissed_pothole_is_not_readable_by_id_either(
    client: AsyncClient, db: AsyncSession
) -> None:
    """404 rather than 403: saying "forbidden" would confirm the row exists."""
    pothole = await make_pothole(db, "archived")

    response = await client.get(f"/api/v1/public/potholes/{pothole.id}")

    assert response.status_code == 404


async def test_the_public_endpoint_needs_no_token(client: AsyncClient, db: AsyncSession) -> None:
    await make_pothole(db, "active")

    response = await client.get("/api/v1/public/potholes", params={"bbox": BBOX})

    assert response.status_code == 200
    assert len(response.json()) == 1


async def test_the_internal_endpoint_still_does(client: AsyncClient) -> None:
    response = await client.get("/api/v1/potholes", params={"bbox": BBOX})

    assert response.status_code == 401


async def test_an_oversized_bounding_box_is_refused(client: AsyncClient) -> None:
    """Without the cap, one request asks for every row in the table."""
    response = await client.get(
        "/api/v1/public/potholes", params={"bbox": "60.0,35.0,75.0,45.0"}
    )

    assert response.status_code == 422
    assert "zoom in" in response.text


async def test_an_inverted_bounding_box_is_refused(client: AsyncClient) -> None:
    response = await client.get(
        "/api/v1/public/potholes", params={"bbox": "69.32,41.34,69.24,41.28"}
    )

    assert response.status_code == 422


async def test_the_reporter_is_never_published(
    client: AsyncClient, db: AsyncSession
) -> None:
    """A Telegram user id is how a person is contacted and banned. It stays internal."""
    pothole = await make_pothole(db, "reported")
    db.add(
        CitizenReport(
            client_report_id=uuid.uuid4(),
            source="telegram_bot",
            pothole_id=pothole.id,
            telegram_user_id=123_456_789,
            telegram_username="someone_real",
            location=point(LAT, LON),
            location_accuracy_m=25.0,
            reported_at=datetime.now(UTC),
            review_state="accepted",
            comment="Яма у перекрёстка",
        )
    )
    await db.commit()

    listing = await client.get("/api/v1/public/potholes", params={"bbox": BBOX})
    detail = await client.get(f"/api/v1/public/potholes/{pothole.id}")

    for body in (listing.text, detail.text):
        assert "123456789" not in body
        assert "someone_real" not in body
    assert detail.json()["comment"] == "Яма у перекрёстка"


async def test_an_unreviewed_photo_is_not_shown_publicly(
    client: AsyncClient, db: AsyncSession
) -> None:
    """A public bot takes images from strangers; publishing them unseen makes this map a
    channel for whatever anyone chose to upload."""
    pothole = await make_pothole(db, "reported")
    db.add(
        CitizenReport(
            client_report_id=uuid.uuid4(),
            source="telegram_bot",
            pothole_id=pothole.id,
            telegram_user_id=1,
            location=point(LAT, LON),
            location_accuracy_m=25.0,
            reported_at=datetime.now(UTC),
            image_key="reports/2026/01/01/whatever.jpg",
            review_state="pending",
        )
    )
    await db.commit()

    detail = await client.get(f"/api/v1/public/potholes/{pothole.id}")

    assert detail.status_code == 200
    assert detail.json()["image_url"] is None


async def test_counts_are_grouped_by_public_state(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_pothole(db, "reported", lat=LAT)
    await make_pothole(db, "active", lat=LAT + 0.001)
    await make_pothole(db, "repaired", lat=LAT + 0.002)
    await make_pothole(db, "archived", lat=LAT + 0.003)

    body = (await client.get("/api/v1/public/counts", params={"bbox": BBOX})).json()

    assert body == {"unverified": 1, "confirmed": 1, "fixed": 1, "total": 3}


async def test_filtering_by_state(client: AsyncClient, db: AsyncSession) -> None:
    await make_pothole(db, "reported", lat=LAT)
    await make_pothole(db, "active", lat=LAT + 0.001)

    body = (
        await client.get(
            "/api/v1/public/potholes", params={"bbox": BBOX, "state": "unverified"}
        )
    ).json()

    assert [item["state"] for item in body] == ["unverified"]


async def test_the_page_is_told_where_to_send_reports(client: AsyncClient) -> None:
    """Served rather than baked into the build, so the bot can be renamed or reporting
    turned off without redeploying the web app."""
    body = (await client.get("/api/v1/public/config")).json()

    assert body["telegram_enabled"] is True
    assert body["report_url"].endswith("?start=report")
    assert body["confirmations_required"] >= 1


# -- Which photo a stranger sees -----------------------------------------------


async def add_detection(
    db: AsyncSession,
    pothole: Pothole,
    driver: User,
    *,
    crop_key: str | None = None,
    full_key: str | None = None,
) -> None:
    drive = DriveSession(user_id=driver.id, status="ended")
    db.add(drive)
    await db.flush()
    db.add(
        DetectionEvent(
            client_event_id=uuid.uuid4(),
            drive_session_id=drive.id,
            pothole_id=pothole.id,
            location=point(LAT, LON),
            location_accuracy_m=6.0,
            detected_at=datetime.now(UTC),
            confidence=0.8,
            severity="medium",
            severity_score=0.5,
            model_version="pothole-detector-0.1.0",
            crop_image_key=crop_key,
            full_image_key=full_key,
            event_metadata={},
        )
    )
    await db.commit()


async def test_a_detector_pothole_shows_its_evidence_crop(
    client: AsyncClient, db: AsyncSession, driver: User
) -> None:
    """Tapping a red dot should show the pothole, not an empty box."""
    pothole = await make_pothole(db, "active")
    await add_detection(db, pothole, driver, crop_key="events/2026/01/01/e1/crop.jpg")

    detail = (await client.get(f"/api/v1/public/potholes/{pothole.id}")).json()

    assert detail["image_url"] is not None
    assert "events/2026/01/01/e1/crop.jpg" in detail["image_url"]


async def test_a_full_frame_is_never_published(
    client: AsyncClient, db: AsyncSession, driver: User
) -> None:
    """A full frame is whatever the windscreen saw - people and number plates included.
    Only the crop around the defect is fit for a public page."""
    pothole = await make_pothole(db, "active")
    await add_detection(db, pothole, driver, full_key="events/2026/01/01/e2/full.jpg")

    detail = (await client.get(f"/api/v1/public/potholes/{pothole.id}")).json()

    assert detail["image_url"] is None


async def test_an_unreviewed_citizen_photo_loses_to_the_detector_crop(
    client: AsyncClient, db: AsyncSession, driver: User
) -> None:
    """The leak this guards: `primary_image_key` can hold a stranger's unreviewed upload,
    so the public route must choose its photo without ever reading that column."""
    pothole = await make_pothole(db, "active")
    pending_key = "reports/2026/01/01/stranger.jpg"
    pothole.primary_image_key = pending_key
    db.add(
        CitizenReport(
            client_report_id=uuid.uuid4(),
            source="telegram_bot",
            pothole_id=pothole.id,
            telegram_user_id=5,
            location=point(LAT, LON),
            location_accuracy_m=25.0,
            reported_at=datetime.now(UTC),
            image_key=pending_key,
            review_state="pending",
        )
    )
    await db.commit()
    await add_detection(db, pothole, driver, crop_key="events/2026/01/01/e3/crop.jpg")

    detail = (await client.get(f"/api/v1/public/potholes/{pothole.id}")).json()

    assert "events/2026/01/01/e3/crop.jpg" in detail["image_url"]
    assert "stranger" not in detail["image_url"]


async def test_an_accepted_citizen_photo_is_preferred(
    client: AsyncClient, db: AsyncSession, driver: User
) -> None:
    """Once an operator has looked at it, a person's photo beats an automatic crop."""
    pothole = await make_pothole(db, "active")
    await add_detection(db, pothole, driver, crop_key="events/2026/01/01/e4/crop.jpg")
    db.add(
        CitizenReport(
            client_report_id=uuid.uuid4(),
            source="telegram_bot",
            pothole_id=pothole.id,
            telegram_user_id=6,
            location=point(LAT, LON),
            location_accuracy_m=25.0,
            reported_at=datetime.now(UTC),
            image_key="reports/2026/01/01/accepted.jpg",
            review_state="accepted",
        )
    )
    await db.commit()

    detail = (await client.get(f"/api/v1/public/potholes/{pothole.id}")).json()

    assert "accepted.jpg" in detail["image_url"]
