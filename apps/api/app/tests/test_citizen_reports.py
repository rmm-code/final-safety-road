"""The rules that decide whether a report from the public becomes a marker on the map.

These run against real PostGIS, because the proximity search that decides "same pothole
or different one" IS a PostGIS query. A fake would prove nothing about production.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import CitizenReport, DriveSession, Pothole, PotholeStatusHistory, User
from app.services.citizen_reports import (
    CitizenReportService,
    ReportInput,
    report_id_for_telegram,
)

# A quiet corner of Tashkent, far from anything the other tests seed.
LAT, LON = 41.2995, 69.2401

# Roughly 90 m north. Comfortably beyond the widest dedup radius, so a report here is
# unambiguously a different pothole rather than a borderline case.
FAR_LAT = LAT + 0.0008


def report(
    *, user_id: int | None, lat: float = LAT, lon: float = LON, **overrides
) -> ReportInput:
    return ReportInput(
        client_report_id=overrides.pop("client_report_id", uuid.uuid4()),
        source="telegram_bot",
        latitude=lat,
        longitude=lon,
        reported_at=overrides.pop("reported_at", datetime.now(UTC)),
        telegram_user_id=user_id,
        **overrides,
    )


async def service(db: AsyncSession) -> CitizenReportService:
    return CitizenReportService(db, get_settings())


async def test_a_first_report_creates_an_unverified_pothole(db: AsyncSession) -> None:
    result = await (await service(db)).submit(report(user_id=1))

    assert result.created_pothole is True
    # Purple on the map. One stranger's word puts a marker there, honestly labelled.
    assert result.pothole.status == "reported"
    assert result.pothole.severity == "unknown", "nobody measured how bad it is"
    assert result.verified_now is False


async def test_two_people_reporting_the_same_hole_produce_one_pothole(
    db: AsyncSession,
) -> None:
    reports = await service(db)
    first = await reports.submit(report(user_id=1))
    second = await reports.submit(report(user_id=2))

    assert second.deduplicated is True
    assert second.pothole.id == first.pothole.id
    assert second.pothole.sighting_count == 2
    assert (await db.execute(select(Pothole))).scalars().all().__len__() == 1


async def test_reports_far_apart_stay_separate(db: AsyncSession) -> None:
    reports = await service(db)
    first = await reports.submit(report(user_id=1))
    second = await reports.submit(report(user_id=2, lat=FAR_LAT))

    assert second.created_pothole is True
    assert second.pothole.id != first.pothole.id


async def test_one_person_cannot_verify_their_own_pothole(db: AsyncSession) -> None:
    """The whole confirmation mechanic rests on reporters being different people.

    Counting reports instead of reporters would let one enthusiast - or one script -
    promote anything to "confirmed" by sending it three times.
    """
    reports = await service(db)
    result = None
    for _ in range(5):
        result = await reports.submit(report(user_id=777))

    assert result is not None
    assert result.distinct_reporters == 1
    assert result.pothole.status == "reported"
    assert result.verified_now is False


async def test_enough_independent_reporters_verify_the_pothole(db: AsyncSession) -> None:
    settings = get_settings()
    reports = await service(db)

    result = None
    for reporter in range(1, settings.citizen_confirmations_to_verify + 1):
        result = await reports.submit(report(user_id=reporter))

    assert result is not None
    assert result.verified_now is True
    # Red on the map: corroborated, not repaired.
    assert result.pothole.status == "active"
    assert result.distinct_reporters == settings.citizen_confirmations_to_verify


async def test_an_automatic_promotion_is_written_to_the_history(db: AsyncSession) -> None:
    """"Why is this red" must be answerable even when no human made the change."""
    settings = get_settings()
    reports = await service(db)
    result = None
    for reporter in range(1, settings.citizen_confirmations_to_verify + 1):
        result = await reports.submit(report(user_id=reporter))
    assert result is not None

    rows = (
        (
            await db.execute(
                select(PotholeStatusHistory).where(
                    PotholeStatusHistory.pothole_id == result.pothole.id
                )
            )
        )
        .scalars()
        .all()
    )

    assert len(rows) == 1
    assert (rows[0].old_status, rows[0].new_status) == ("reported", "active")
    assert rows[0].changed_by is None, "nobody did it; the rule did"
    assert "citizen" in (rows[0].reason or "")


async def test_a_redelivered_report_does_not_become_a_second_pothole(
    db: AsyncSession,
) -> None:
    """Telegram redelivers any update the webhook did not answer in time."""
    reports = await service(db)
    key = report_id_for_telegram(chat_id=42, message_id=7)

    first = await reports.submit(report(user_id=1, client_report_id=key))
    again = await reports.submit(report(user_id=1, client_report_id=key))

    assert again.already_reported is True
    assert again.report.id == first.report.id
    assert (await db.execute(select(CitizenReport))).scalars().all().__len__() == 1
    assert first.pothole.sighting_count == 1


def test_the_idempotency_key_is_derived_from_the_message() -> None:
    assert report_id_for_telegram(1, 2) == report_id_for_telegram(1, 2)
    assert report_id_for_telegram(1, 2) != report_id_for_telegram(1, 3)
    assert report_id_for_telegram(1, 2) != report_id_for_telegram(2, 2)


async def test_our_own_detector_verifies_a_citizen_reported_pothole(
    db: AsyncSession, driver: User
) -> None:
    """Evidence frames are the verification "reported" is waiting for."""
    from app.schemas.detection import DetectionEventCreate
    from app.services.ingest import IngestService

    reported = await (await service(db)).submit(report(user_id=1))
    assert reported.pothole.status == "reported"

    drive = DriveSession(user_id=driver.id, status="active")
    db.add(drive)
    await db.flush()

    ingest = IngestService(db, get_settings())
    outcome = await ingest.ingest(
        DetectionEventCreate(
            clientEventId=uuid.uuid4(),
            driveSessionId=drive.id,
            detectedAt=datetime.now(UTC),
            confidence=0.81,
            severity="large",
            severityScore=0.7,
            latitude=LAT,
            longitude=LON,
            locationAccuracyM=6.0,
            modelVersion="pothole-detector-0.1.0",
        )
    )

    assert outcome.deduplicated is True
    assert outcome.pothole.id == reported.pothole.id
    assert outcome.pothole.status == "active"
    assert outcome.pothole.severity == "large", "the detector does measure this"

    history = (
        (
            await db.execute(
                select(PotholeStatusHistory).where(
                    PotholeStatusHistory.pothole_id == reported.pothole.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert [(row.old_status, row.new_status) for row in history] == [("reported", "active")]


async def test_rejecting_a_report_can_demote_a_pothole(
    db: AsyncSession, operator: User
) -> None:
    """Verification rests on the reports; withdrawing one has to be able to undo it."""
    settings = get_settings()
    reports = await service(db)

    submitted = []
    for reporter in range(1, settings.citizen_confirmations_to_verify + 1):
        submitted.append(await reports.submit(report(user_id=reporter)))

    pothole = submitted[-1].pothole
    assert pothole.status == "active"

    await reports.review(
        submitted[0].report, state="rejected", reviewer_id=operator.id, note="not a pothole"
    )

    await db.refresh(pothole)
    assert pothole.status == "reported", "corroboration fell below the threshold"


async def test_rejecting_a_report_leaves_a_detector_backed_pothole_alone(
    db: AsyncSession, operator: User, driver: User
) -> None:
    """A junk photo says nothing about our own evidence frames."""
    from app.schemas.detection import DetectionEventCreate
    from app.services.ingest import IngestService

    drive = DriveSession(user_id=driver.id, status="active")
    db.add(drive)
    await db.flush()

    await IngestService(db, get_settings()).ingest(
        DetectionEventCreate(
            clientEventId=uuid.uuid4(),
            driveSessionId=drive.id,
            detectedAt=datetime.now(UTC),
            confidence=0.9,
            severity="medium",
            severityScore=0.5,
            latitude=LAT,
            longitude=LON,
            locationAccuracyM=5.0,
            modelVersion="pothole-detector-0.1.0",
        )
    )

    reports = await service(db)
    submitted = await reports.submit(report(user_id=1))
    pothole = submitted.pothole
    assert pothole.status == "active"

    await reports.review(submitted.report, state="rejected", reviewer_id=operator.id)

    await db.refresh(pothole)
    assert pothole.status == "active"


async def test_a_report_revives_a_pothole_someone_thought_was_repaired(
    db: AsyncSession,
) -> None:
    reports = await service(db)
    first = await reports.submit(report(user_id=1))
    first.pothole.status = "suspected_repaired"
    await db.flush()

    second = await reports.submit(report(user_id=2))

    assert second.pothole.id == first.pothole.id
    assert second.pothole.status == "active", "someone is standing in front of it"


@pytest.mark.parametrize(
    ("accuracy", "expected"),
    [
        (None, 25.0),  # a dropped pin reports nothing, so nothing is claimed
        (2.0, 8.0),  # never better than a phone can actually do
        (40.0, 40.0),  # a genuinely poor fix is taken at its word
    ],
)
def test_reported_accuracy_is_never_flattered(accuracy: float | None, expected: float) -> None:
    """Dedup widens its search with accuracy, so an optimistic figure splits one
    pothole into several."""
    assert report(user_id=1, location_accuracy_m=accuracy).accuracy_m == expected


async def test_an_old_report_still_matches_a_known_pothole(db: AsyncSession) -> None:
    """Recency is a tiebreak, not a gate: a road defect does not move."""
    reports = await service(db)
    first = await reports.submit(report(user_id=1))
    second = await reports.submit(
        report(user_id=2, reported_at=datetime.now(UTC) + timedelta(days=45))
    )

    assert second.pothole.id == first.pothole.id
