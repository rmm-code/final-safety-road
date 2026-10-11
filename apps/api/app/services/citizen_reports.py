"""Turning a report from the public into a sighting of a physical pothole.

The same rule as `ingest.py`, applied to a different kind of witness: one report is not
one new pothole. Three people photographing the same hole from three angles must produce
one marker on the map, not three.

What differs from a detector sighting is what is KNOWN. A detection carries a confidence
and a visual severity derived from pixels; a person carries neither. So a citizen report
contributes position and existence, and nothing else - severity stays "unknown" until our
own detector or an operator says otherwise. Inventing a severity from "the person said it
was big" would put a number on the map that nothing measured.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import CitizenReport, Pothole, PotholeStatusHistory
from app.repositories.potholes import PotholeRepository, point
from app.services.dedup import merge_location, score_candidate, search_radius_m

# A dropped pin or a Telegram location share reports no accuracy figure, so one is
# assumed. Chosen to match a typical phone fix rather than to flatter the report: it
# feeds the dedup search radius, and claiming better precision than a person tapping a
# map actually has would split one pothole into several.
ASSUMED_REPORT_ACCURACY_M = 25.0

# Telegram's live-location shares do carry a horizontal accuracy, and it is trusted when
# present - but never below this, for the same reason.
MIN_REPORT_ACCURACY_M = 8.0

# The status a pothole gets when nothing but a member of the public has vouched for it.
UNVERIFIED_STATUS = "reported"
VERIFIED_STATUS = "active"


@dataclass(slots=True)
class ReportResult:
    report: CitizenReport
    pothole: Pothole
    latitude: float
    longitude: float
    deduplicated: bool
    created_pothole: bool
    already_reported: bool
    verified_now: bool
    distinct_reporters: int


@dataclass(slots=True)
class ReportInput:
    """One submitted report, independent of how it arrived."""

    client_report_id: uuid.UUID
    source: str
    latitude: float
    longitude: float
    reported_at: datetime
    location_accuracy_m: float | None = None
    comment: str | None = None
    telegram_user_id: int | None = None
    telegram_username: str | None = None
    telegram_chat_id: int | None = None

    @property
    def accuracy_m(self) -> float:
        if self.location_accuracy_m is None:
            return ASSUMED_REPORT_ACCURACY_M
        return max(MIN_REPORT_ACCURACY_M, float(self.location_accuracy_m))


def report_id_for_telegram(chat_id: int, message_id: int) -> uuid.UUID:
    """Idempotency key for a report that arrived through Telegram.

    Telegram redelivers an update whenever the webhook does not answer 200 quickly
    enough, so "the same message twice" is normal traffic, not an edge case. Deriving the
    key from the message means the unique constraint absorbs the retry - the same
    protection `clientEventId` gives the drive uploader, for a client that cannot
    generate its own id.
    """
    return uuid.uuid5(uuid.NAMESPACE_URL, f"telegram:{chat_id}:{message_id}")


class CitizenReportService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._potholes = PotholeRepository(session)

    async def submit(self, payload: ReportInput) -> ReportResult:
        existing = (
            await self._session.execute(
                select(CitizenReport).where(
                    CitizenReport.client_report_id == payload.client_report_id
                )
            )
        ).scalar_one_or_none()

        if existing is not None:
            pothole = (
                await self._session.get(Pothole, existing.pothole_id)
                if existing.pothole_id
                else None
            )
            if pothole is None:
                # The pothole was deleted or the earlier attempt failed mid-flight.
                pothole = await self._create_pothole(payload)
                existing.pothole_id = pothole.id
            found = await self._potholes.get(pothole.id)
            latitude, longitude = (
                (found[1], found[2]) if found else (payload.latitude, payload.longitude)
            )
            return ReportResult(
                report=existing,
                pothole=pothole,
                latitude=latitude,
                longitude=longitude,
                deduplicated=True,
                created_pothole=False,
                already_reported=True,
                verified_now=False,
                distinct_reporters=await self.distinct_reporters(pothole.id),
            )

        pothole, deduplicated, latitude, longitude = await self._resolve_pothole(payload)

        report = CitizenReport(
            client_report_id=payload.client_report_id,
            source=payload.source,
            pothole_id=pothole.id,
            telegram_user_id=payload.telegram_user_id,
            telegram_username=payload.telegram_username,
            telegram_chat_id=payload.telegram_chat_id,
            location=point(payload.latitude, payload.longitude),
            location_accuracy_m=payload.accuracy_m,
            reported_at=payload.reported_at,
            comment=payload.comment,
            review_state="pending",
        )
        self._session.add(report)
        await self._session.flush()

        reporters, verified_now = await self._maybe_verify(pothole)
        await self._session.flush()

        return ReportResult(
            report=report,
            pothole=pothole,
            latitude=latitude,
            longitude=longitude,
            deduplicated=deduplicated,
            created_pothole=not deduplicated,
            already_reported=False,
            verified_now=verified_now,
            distinct_reporters=reporters,
        )

    async def distinct_reporters(self, pothole_id: uuid.UUID) -> int:
        """How many DIFFERENT people have reported this pothole.

        Counting reports instead would let one person verify their own sighting by
        sending the same hole three times, which is the whole mechanic defeated. Reports
        with no identifiable reporter count once between them, for the same reason.
        """
        return int(
            (
                await self._session.execute(
                    select(func.count(func.distinct(CitizenReport.telegram_user_id))).where(
                        CitizenReport.pothole_id == pothole_id,
                        CitizenReport.review_state != "rejected",
                    )
                )
            ).scalar_one()
        )

    async def _maybe_verify(self, pothole: Pothole) -> tuple[int, bool]:
        """Promote an unverified pothole once enough independent people agree."""
        reporters = await self.distinct_reporters(pothole.id)
        if pothole.status != UNVERIFIED_STATUS:
            return reporters, False
        if reporters < self._settings.citizen_confirmations_to_verify:
            return reporters, False

        self._record_status_change(
            pothole,
            VERIFIED_STATUS,
            reason=f"auto: {reporters} independent citizen reports",
        )
        return reporters, True

    def _record_status_change(self, pothole: Pothole, new_status: str, *, reason: str) -> None:
        """Change status and leave a trail.

        Every transition is written down, including the ones no human made: the history
        table exists so "why is this red" is always answerable, and an automatic promotion
        is exactly the kind of change someone will later want explained.
        """
        if pothole.status == new_status:
            return
        self._session.add(
            PotholeStatusHistory(
                pothole_id=pothole.id,
                old_status=pothole.status,
                new_status=new_status,
                reason=reason,
                changed_by=None,
            )
        )
        pothole.status = new_status

    async def _resolve_pothole(self, payload: ReportInput) -> tuple[Pothole, bool, float, float]:
        radius = search_radius_m(
            payload.accuracy_m,
            self._settings.dedup_radius_m,
            self._settings.dedup_max_radius_m,
        )
        candidates = await self._potholes.nearby(
            latitude=payload.latitude, longitude=payload.longitude, radius_m=radius
        )

        best: tuple[Pothole, float, float, float] | None = None
        for pothole, latitude, longitude in candidates:
            score = score_candidate(
                event_lat=payload.latitude,
                event_lon=payload.longitude,
                event_accuracy_m=payload.accuracy_m,
                # A person reports a place, not a direction of travel, and claims no
                # severity. Both fall through to the "unknown" branches of the scorer.
                event_heading_deg=None,
                event_severity="unknown",
                event_detected_at=payload.reported_at,
                pothole_lat=latitude,
                pothole_lon=longitude,
                pothole_heading_deg=None,
                pothole_severity=pothole.severity,
                pothole_last_seen_at=pothole.last_seen_at,
                base_radius_m=self._settings.dedup_radius_m,
                max_radius_m=self._settings.dedup_max_radius_m,
            )
            if best is None or score.total > best[3]:
                best = (pothole, latitude, longitude, score.total)

        if best and best[3] >= self._settings.dedup_merge_threshold:
            latitude, longitude = self._merge(best[0], best[1], best[2], payload)
            return best[0], True, latitude, longitude

        pothole = await self._create_pothole(payload)
        return pothole, False, payload.latitude, payload.longitude

    def _merge(
        self, pothole: Pothole, latitude: float, longitude: float, payload: ReportInput
    ) -> tuple[float, float]:
        new_lat, new_lon, accuracy = merge_location(
            existing_lat=latitude,
            existing_lon=longitude,
            existing_accuracy_m=float(pothole.location_accuracy_m),
            existing_sightings=pothole.sighting_count,
            new_lat=payload.latitude,
            new_lon=payload.longitude,
            new_accuracy_m=payload.accuracy_m,
        )

        pothole.location = point(new_lat, new_lon)
        pothole.location_accuracy_m = accuracy
        pothole.sighting_count += 1
        # Severity is deliberately untouched: a person did not measure it.
        if payload.reported_at > pothole.last_seen_at:
            pothole.last_seen_at = payload.reported_at
        if payload.reported_at < pothole.first_seen_at:
            pothole.first_seen_at = payload.reported_at
        if pothole.status == "suspected_repaired":
            # Someone is standing in front of it, so it is evidently not repaired.
            self._record_status_change(
                pothole, VERIFIED_STATUS, reason="citizen report on a suspected-repaired pothole"
            )
        return new_lat, new_lon

    async def _create_pothole(self, payload: ReportInput) -> Pothole:
        pothole = Pothole(
            location=point(payload.latitude, payload.longitude),
            location_accuracy_m=payload.accuracy_m,
            severity="unknown",
            severity_score=0,
            # Unverified until corroborated. This is the whole point of the status: one
            # stranger's word puts a marker on the map, but an honestly-labelled one.
            status=UNVERIFIED_STATUS,
            first_seen_at=payload.reported_at,
            last_seen_at=payload.reported_at,
            sighting_count=1,
        )
        self._session.add(pothole)
        await self._session.flush()
        return pothole

    async def attach_image(self, report: CitizenReport, key: str) -> None:
        report.image_key = key
        pothole = (
            await self._session.get(Pothole, report.pothole_id) if report.pothole_id else None
        )
        # A citizen photo becomes the pothole's face only when the pothole has none. A
        # reviewed detector crop is better evidence and is not displaced by a snapshot.
        if pothole is not None and pothole.primary_image_key is None:
            pothole.primary_image_key = key

    async def review(
        self,
        report: CitizenReport,
        *,
        state: str,
        reviewer_id: uuid.UUID,
        note: str | None = None,
    ) -> CitizenReport:
        """Accept or reject a report.

        Rejecting withdraws the report's vote, which can leave a pothole that was
        auto-verified sitting above the threshold on rejected evidence - so the count is
        re-checked and the pothole demoted if it no longer holds up.
        """
        report.review_state = state
        report.review_note = note
        report.reviewed_by = reviewer_id
        report.reviewed_at = datetime.now(UTC)
        await self._session.flush()

        if report.pothole_id is None:
            return report
        pothole = await self._session.get(Pothole, report.pothole_id)
        if pothole is None:
            return report

        if state == "rejected":
            reporters = await self.distinct_reporters(pothole.id)
            if (
                pothole.status == VERIFIED_STATUS
                and reporters < self._settings.citizen_confirmations_to_verify
                and not await self._has_detector_evidence(pothole.id)
            ):
                self._record_status_change(
                    pothole,
                    UNVERIFIED_STATUS,
                    reason="citizen report rejected; corroboration fell below threshold",
                )
        else:
            await self._maybe_verify(pothole)

        # Flushed here rather than left to the caller's commit: a status change that only
        # exists in the identity map is invisible to anything that re-reads the row, and
        # the route serialises the pothole immediately after this returns.
        await self._session.flush()
        return report

    async def _has_detector_evidence(self, pothole_id: uuid.UUID) -> bool:
        """Whether our own detector has seen this pothole.

        A pothole the vision pipeline found stays verified regardless of what the public
        does: rejecting a citizen photo says nothing about the evidence frames.
        """
        from app.models import DetectionEvent

        return bool(
            (
                await self._session.execute(
                    select(func.count(DetectionEvent.id)).where(
                        DetectionEvent.pothole_id == pothole_id
                    )
                )
            ).scalar_one()
        )
