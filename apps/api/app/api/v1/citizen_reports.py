"""Reports from the public: submitted by the Mini App, curated by operators.

Two audiences on one router, separated by dependency: the submit route authenticates with
a Telegram `initData` signature and no account; every other route requires an operator.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status

from app.api.deps import CurrentUser, DbDep, SettingsDep, public_rate_limit, require_roles
from app.models import Pothole, User
from app.repositories.citizen_reports import CitizenReportRepository
from app.schemas.citizen_report import (
    CitizenReportAccepted,
    CitizenReportCreate,
    CitizenReportOut,
    CitizenReportReview,
    UploadTarget,
)
from app.services.citizen_reports import CitizenReportService, ReportInput
from app.services.storage import ObjectStorage, StorageError
from app.services.telegram import InitDataError, verify_init_data

router = APIRouter(prefix="/citizen-reports", tags=["citizen-reports"])

MINI_APP_CONTENT_TYPE = "image/jpeg"


@router.post(
    "",
    response_model=CitizenReportAccepted,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(public_rate_limit)],
)
async def submit_report(
    payload: CitizenReportCreate,
    db: DbDep,
    settings: SettingsDep,
    init_data: str | None = Header(default=None, alias="X-Telegram-Init-Data"),
    image_content_type: str = Query(default=MINI_APP_CONTENT_TYPE),
) -> CitizenReportAccepted:
    """Submit a report from the Telegram Mini App.

    Identity comes from the signed `initData` header and nowhere else. The body deliberately
    has no reporter field: a client that could name its own user could report as anybody,
    and the whole confirmation mechanic rests on reporters being distinct people.
    """
    if not settings.telegram_enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Telegram is not configured on this deployment"
        )

    try:
        verified = verify_init_data(
            init_data or "",
            settings.telegram_bot_token,
            max_age_seconds=settings.telegram_init_data_max_age_seconds,
        )
    except InitDataError as error:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, str(error)) from error

    service = CitizenReportService(db, settings)
    result = await service.submit(
        ReportInput(
            client_report_id=payload.client_report_id,
            source="telegram_miniapp",
            latitude=payload.latitude,
            longitude=payload.longitude,
            reported_at=datetime.now(UTC),
            location_accuracy_m=payload.location_accuracy_m,
            comment=payload.comment,
            telegram_user_id=verified.user.id,
            telegram_username=verified.user.username,
        )
    )

    # The Mini App runs on a phone, so it POSTs its own photo rather than pushing bytes
    # through this process - the same arrangement the drive uploader uses.
    upload: UploadTarget | None = None
    if not result.already_reported:
        try:
            storage = ObjectStorage(settings)
            key = storage.build_report_key(
                report_id=result.report.id,
                reported_at=result.report.reported_at,
                content_type=image_content_type,
            )
            form = storage.presign_upload(key, image_content_type)
            upload = UploadTarget(
                key=key,
                url=form.url,
                fields=form.fields,
                expires_in_seconds=settings.upload_url_ttl_seconds,
            )
            await service.attach_image(result.report, key)
        except StorageError as error:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
        except Exception:
            # Storage down costs the photo, never the report.
            upload = None

    return CitizenReportAccepted(
        id=result.report.id,
        pothole_id=result.pothole.id,
        latitude=result.latitude,
        longitude=result.longitude,
        status=result.pothole.status,  # type: ignore[arg-type]
        created_pothole=result.created_pothole,
        deduplicated=result.deduplicated,
        already_reported=result.already_reported,
        verified_now=result.verified_now,
        distinct_reporters=result.distinct_reporters,
        confirmations_required=settings.citizen_confirmations_to_verify,
        sighting_count=result.pothole.sighting_count,
        image_upload=upload,
    )


@router.get("", response_model=list[CitizenReportOut])
async def list_reports(
    db: DbDep,
    settings: SettingsDep,
    _user: CurrentUser,
    review_state: str | None = Query(default="pending"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[CitizenReportOut]:
    """The operator queue. Oldest first, because it is work rather than a feed."""
    storage = ObjectStorage(settings)
    rows = await CitizenReportRepository(db).queue(
        review_state=review_state, limit=limit, offset=offset
    )

    out: list[CitizenReportOut] = []
    for report, latitude, longitude, pothole in rows:
        image_url: str | None = None
        if report.image_key:
            try:
                image_url = storage.presign_get(report.image_key)
            except Exception:
                image_url = None
        out.append(
            CitizenReportOut(
                id=report.id,
                pothole_id=report.pothole_id,
                source=report.source,  # type: ignore[arg-type]
                latitude=latitude,
                longitude=longitude,
                location_accuracy_m=float(report.location_accuracy_m),
                reported_at=report.reported_at,
                comment=report.comment,
                image_url=image_url,
                review_state=report.review_state,  # type: ignore[arg-type]
                review_note=report.review_note,
                reviewed_at=report.reviewed_at,
                telegram_username=report.telegram_username,
                pothole_status=pothole.status if pothole else None,  # type: ignore[arg-type]
                pothole_severity=pothole.severity if pothole else None,  # type: ignore[arg-type]
            )
        )
    return out


@router.post("/{report_id}/review", response_model=CitizenReportOut)
async def review_report(
    report_id: uuid.UUID,
    payload: CitizenReportReview,
    db: DbDep,
    settings: SettingsDep,
    user: User = Depends(require_roles("admin", "operator")),
) -> CitizenReportOut:
    """Accept or reject one report.

    Accepting releases the photo to the public map and counts toward verification.
    Rejecting withdraws it, and can demote a pothole that was only verified by reports
    that turned out to be junk.
    """
    repository = CitizenReportRepository(db)
    found = await repository.get(report_id)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Report not found")

    report, latitude, longitude = found
    service = CitizenReportService(db, settings)
    await service.review(
        report, state=payload.state, reviewer_id=user.id, note=payload.note
    )

    image_url: str | None = None
    if report.image_key:
        try:
            image_url = ObjectStorage(settings).presign_get(report.image_key)
        except Exception:
            image_url = None

    pothole = await db.get(Pothole, report.pothole_id) if report.pothole_id else None

    return CitizenReportOut(
        id=report.id,
        pothole_id=report.pothole_id,
        source=report.source,  # type: ignore[arg-type]
        latitude=latitude,
        longitude=longitude,
        location_accuracy_m=float(report.location_accuracy_m),
        reported_at=report.reported_at,
        comment=report.comment,
        image_url=image_url,
        review_state=report.review_state,  # type: ignore[arg-type]
        review_note=report.review_note,
        reviewed_at=report.reviewed_at,
        telegram_username=report.telegram_username,
        pothole_status=pothole.status if pothole else None,  # type: ignore[arg-type]
        pothole_severity=pothole.severity if pothole else None,  # type: ignore[arg-type]
    )


@router.get("/pending-count")
async def pending_count(db: DbDep, _user: CurrentUser) -> dict[str, int]:
    return {"pending": await CitizenReportRepository(db).pending_count()}

