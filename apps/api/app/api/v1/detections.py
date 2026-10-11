from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.api.deps import CurrentUser, DbDep, SettingsDep, rate_limit
from app.models import DriveSession
from app.schemas.detection import (
    DetectionEventAccepted,
    DetectionEventCreate,
    DetectionEventOut,
    UploadTarget,
)
from app.services.ingest import IngestService
from app.services.storage import ALLOWED_CONTENT_TYPES, ObjectStorage, StorageError

router = APIRouter(prefix="/detections", tags=["detections"], dependencies=[Depends(rate_limit)])


@router.post("", response_model=DetectionEventAccepted, status_code=status.HTTP_201_CREATED)
async def create_detection(
    payload: DetectionEventCreate,
    db: DbDep,
    user: CurrentUser,
    settings: SettingsDep,
    image_content_type: str = Query(
        default="image/webp", description="Content type the client will upload"
    ),
) -> DetectionEventAccepted:
    """Ingest one sighting.

    Idempotent on `clientEventId`: a phone that retries after a lost connection gets the
    original event back rather than creating a duplicate. The response says whether the
    sighting joined an existing pothole, because one upload does not mean one new defect.
    """
    session = await db.get(DriveSession, payload.drive_session_id)
    if session is None or (session.user_id != user.id and user.role not in {"admin", "operator"}):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Drive session not found")

    if image_content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"Images must be one of: {', '.join(sorted(ALLOWED_CONTENT_TYPES))}",
        )

    service = IngestService(db, settings)
    result = await service.ingest(payload)

    full_upload: UploadTarget | None = None
    crop_upload: UploadTarget | None = None

    if not result.already_ingested:
        storage = ObjectStorage(settings)
        try:
            full_key = storage.build_key(
                event_id=result.event.id,
                kind="full",
                detected_at=payload.detected_at,
                content_type=image_content_type,
            )
            crop_key = storage.build_key(
                event_id=result.event.id,
                kind="crop",
                detected_at=payload.detected_at,
                content_type=image_content_type,
            )
            # Large bodies never pass through this process; the client POSTs directly.
            full_form = storage.presign_upload(full_key, image_content_type)
            crop_form = storage.presign_upload(crop_key, image_content_type)
            full_upload = UploadTarget(
                key=full_key,
                url=full_form.url,
                fields=full_form.fields,
                expires_in_seconds=settings.upload_url_ttl_seconds,
            )
            crop_upload = UploadTarget(
                key=crop_key,
                url=crop_form.url,
                fields=crop_form.fields,
                expires_in_seconds=settings.upload_url_ttl_seconds,
            )
            await service.attach_image_keys(result.event, full_key=full_key, crop_key=crop_key)
        except StorageError as error:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
        except Exception:
            # Storage being down must not lose the sighting: the event is already
            # recorded, it simply has no evidence image.
            full_upload = None
            crop_upload = None

    return DetectionEventAccepted(
        event=DetectionEventOut(
            id=result.event.id,
            client_event_id=result.event.client_event_id,
            pothole_id=result.event.pothole_id,
            drive_session_id=result.event.drive_session_id,
            detected_at=result.event.detected_at,
            confidence=float(result.event.confidence),
            severity=result.event.severity,  # type: ignore[arg-type]
            severity_score=float(result.event.severity_score),
            latitude=result.latitude,
            longitude=result.longitude,
            location_accuracy_m=float(result.event.location_accuracy_m),
            location_source=result.event.location_source,  # type: ignore[arg-type]
            model_version=result.event.model_version,
        ),
        pothole_id=result.pothole.id,
        deduplicated=result.deduplicated,
        created_pothole=result.created_pothole,
        already_ingested=result.already_ingested,
        full_image_upload=full_upload,
        crop_image_upload=crop_upload,
    )


@router.get("/{event_id}", response_model=DetectionEventOut)
async def get_detection(event_id: uuid.UUID, db: DbDep, user: CurrentUser) -> DetectionEventOut:
    from app.repositories.events import DetectionEventRepository

    repository = DetectionEventRepository(db)
    event = await repository.get(event_id)
    if event is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Detection event not found")

    latitude, longitude = await repository.coordinates(event)
    return DetectionEventOut(
        id=event.id,
        client_event_id=event.client_event_id,
        pothole_id=event.pothole_id,
        drive_session_id=event.drive_session_id,
        detected_at=event.detected_at,
        confidence=float(event.confidence),
        severity=event.severity,  # type: ignore[arg-type]
        severity_score=float(event.severity_score),
        latitude=latitude,
        longitude=longitude,
        location_accuracy_m=float(event.location_accuracy_m),
        location_source=event.location_source,  # type: ignore[arg-type]
        model_version=event.model_version,
    )
