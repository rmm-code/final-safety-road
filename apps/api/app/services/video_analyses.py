"""Saving browser video analyses and handing them back for replay.

The rule this service holds: a saved video is NOT a source of sightings. A video file has
no GPS, so the only position it can have is one a person placed by hand for the whole
clip. Nothing here creates a `DetectionEvent` or a `Pothole`, and nothing goes near dedup:
merging every pothole of a clip into one hand-placed point, and tightening its accuracy on
each merge, would fabricate precision on the map.

Objects are uploaded by the browser straight to storage, through targets this service
signs. A URL is handed out only for an object the client has marked uploaded, so an upload
that failed reads as "not stored" instead of a broken player or image.

Every write commits before it returns. `get_db` commits in a teardown that FastAPI runs
after the response is sent, and a browser that receives 201 starts uploading at once.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import User, VideoAnalysis, VideoAnalysisPothole
from app.repositories.potholes import point
from app.repositories.video_analyses import VideoAnalysisRepository
from app.schemas.common import UploadTarget
from app.schemas.video_analysis import (
    LocatedVideoAnalysis,
    LocatedVideoAnalysisList,
    SeverityCounts,
    VideoAnalysisComplete,
    VideoAnalysisCreate,
    VideoAnalysisCreated,
    VideoAnalysisDetail,
    VideoAnalysisList,
    VideoAnalysisSummary,
    VideoAnalysisUploads,
    VideoLocationIn,
    VideoLocationOut,
    VideoPotholeGallery,
    VideoPotholeGalleryItem,
    VideoPotholeOut,
    VideoPotholeUploads,
)
from app.services.storage import (
    OVERLAY_CONTENT_TYPE,
    VIDEO_ANALYSIS_IMAGE_TYPE,
    ObjectStorage,
)

# Who may change an analysis besides the person who saved it.
CURATOR_ROLES = frozenset({"admin", "operator"})
MAX_LISTED = 200
# Markers in one map viewport. Far more than a screen can show legibly.
MAX_LOCATED = 500
THUMBNAILS_PER_MARKER = 4
# A placed video says so wherever it is shown, exactly as a hand-placed sighting does.
MANUAL_SOURCE = "manual"


class VideoAnalysisError(Exception):
    pass


class VideoAnalysisNotFound(VideoAnalysisError):
    pass


class VideoAnalysisForbidden(VideoAnalysisError):
    """Only the uploader, an operator or an admin may change an analysis."""


class VideoAnalysisIdTaken(VideoAnalysisError):
    """The id belongs to an analysis someone else saved."""


@dataclass(slots=True)
class CreateResult:
    body: VideoAnalysisCreated
    # False when the id already existed: a retried create, answered with what is stored.
    created: bool


class VideoAnalysisService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self._session = session
        self._settings = settings
        self._repository = VideoAnalysisRepository(session)
        self._storage = ObjectStorage(settings)

    # --- Writes -------------------------------------------------------------------------

    async def create(self, payload: VideoAnalysisCreate, user: User) -> CreateResult:
        """Save an analysis under the client's id, or return the one already saved.

        A repeat returns fresh upload targets for whatever has not been marked uploaded,
        for the same keys, so an interrupted upload can simply be finished.
        """
        found = await self._repository.get(payload.id)
        if found is None:
            analysis, potholes = self._build(payload, user)
            if await self._repository.add_unless_exists(analysis, potholes):
                await self._session.commit()
                return CreateResult(self._created(analysis, None, None, potholes), created=True)
            # A simultaneous attempt with the same id won the insert.
            found = await self._repository.get(payload.id)
            if found is None:  # pragma: no cover - add_unless_exists saw the row
                raise VideoAnalysisNotFound(payload.id)

        analysis, latitude, longitude = found
        if analysis.created_by != user.id:
            # Never adopt someone else's analysis by guessing its id: the targets handed
            # back would let a stranger upload into it.
            raise VideoAnalysisIdTaken(payload.id)
        potholes = await self._repository.potholes(analysis.id)
        return CreateResult(self._created(analysis, latitude, longitude, potholes), created=False)

    async def complete(
        self, analysis_id: uuid.UUID, marks: VideoAnalysisComplete, user: User
    ) -> VideoAnalysisDetail:
        """Record which uploads finished. Never un-marks.

        A mark for an object that was never offered (a demo clip's video, a crop the
        client said it did not have, an unknown track) is ignored rather than refused: it
        cannot make a URL appear for an object that does not exist.
        """
        analysis, latitude, longitude = await self._get(analysis_id)
        self._authorize(analysis, user)
        potholes = await self._repository.potholes(analysis_id)

        now = datetime.now(UTC)
        if marks.overlay and analysis.overlay_key and analysis.overlay_uploaded_at is None:
            analysis.overlay_uploaded_at = now
        if marks.poster and analysis.poster_key and analysis.poster_uploaded_at is None:
            analysis.poster_uploaded_at = now
        if marks.video and analysis.video_key and analysis.video_uploaded_at is None:
            analysis.video_uploaded_at = now
        crops, fulls = set(marks.crops), set(marks.fulls)
        for pothole in potholes:
            if pothole.track_id in crops and pothole.crop_key and pothole.crop_uploaded_at is None:
                pothole.crop_uploaded_at = now
            if pothole.track_id in fulls and pothole.full_key and pothole.full_uploaded_at is None:
                pothole.full_uploaded_at = now

        await self._session.commit()
        return self._detail(analysis, latitude, longitude, potholes)

    async def set_location(
        self, analysis_id: uuid.UUID, location: VideoLocationIn, user: User
    ) -> VideoAnalysisDetail:
        """Place a video on the map by hand. Creates no sighting and no pothole."""
        analysis, _, _ = await self._get(analysis_id)
        self._authorize(analysis, user)

        analysis.location = point(location.latitude, location.longitude)
        # Rounded to what the column keeps, so this answer matches every later read.
        analysis.location_accuracy_m = round(location.accuracy_m, 2)
        analysis.location_label = location.label
        analysis.location_source = MANUAL_SOURCE
        analysis.location_set_at = datetime.now(UTC)
        analysis.location_set_by = user.id
        await self._session.commit()

        potholes = await self._repository.potholes(analysis_id)
        return self._detail(analysis, location.latitude, location.longitude, potholes)

    async def clear_location(self, analysis_id: uuid.UUID, user: User) -> VideoAnalysisDetail:
        analysis, _, _ = await self._get(analysis_id)
        self._authorize(analysis, user)

        analysis.location = None
        analysis.location_accuracy_m = None
        analysis.location_label = None
        analysis.location_source = None
        analysis.location_set_at = None
        analysis.location_set_by = None
        await self._session.commit()

        potholes = await self._repository.potholes(analysis_id)
        return self._detail(analysis, None, None, potholes)

    # --- Reads --------------------------------------------------------------------------

    async def detail(self, analysis_id: uuid.UUID) -> VideoAnalysisDetail:
        analysis, latitude, longitude = await self._get(analysis_id)
        potholes = await self._repository.potholes(analysis_id)
        return self._detail(analysis, latitude, longitude, potholes)

    async def recent(self) -> VideoAnalysisList:
        rows = await self._repository.recent(MAX_LISTED)
        counts = await self._repository.severity_counts([row[0].id for row in rows])
        return VideoAnalysisList(
            items=[
                self._summary(analysis, latitude, longitude, counts.get(analysis.id, {}))
                for analysis, latitude, longitude in rows
            ]
        )

    async def located(
        self, *, min_lng: float, min_lat: float, max_lng: float, max_lat: float
    ) -> LocatedVideoAnalysisList:
        rows = await self._repository.located_in_bbox(
            min_lng=min_lng, min_lat=min_lat, max_lng=max_lng, max_lat=max_lat, limit=MAX_LOCATED
        )
        ids = [row[0].id for row in rows]
        counts = await self._repository.severity_counts(ids)
        thumbnails = await self._repository.thumbnail_keys(ids, THUMBNAILS_PER_MARKER)
        items = []
        for analysis, latitude, longitude in rows:
            signed = (self._read_url(key) for key in thumbnails.get(analysis.id, []))
            items.append(
                LocatedVideoAnalysis(
                    id=analysis.id,
                    title=analysis.title,
                    latitude=latitude,
                    longitude=longitude,
                    accuracy_m=float(analysis.location_accuracy_m),
                    label=analysis.location_label,
                    pothole_count=sum(counts.get(analysis.id, {}).values()),
                    poster_url=self._poster_url(analysis),
                    thumbnails=[url for url in signed if url],
                )
            )
        return LocatedVideoAnalysisList(items=items)

    async def pothole_gallery(self, *, limit: int, offset: int) -> VideoPotholeGallery:
        rows = await self._repository.pothole_page(limit=limit, offset=offset)
        total = await self._repository.count_potholes()
        return VideoPotholeGallery(
            items=[
                VideoPotholeGalleryItem(
                    **self._pothole_fields(pothole),
                    analysis_id=pothole.analysis_id,
                    analysis_title=title,
                    located=located,
                )
                for pothole, title, located in rows
            ],
            total=total,
        )

    # --- Building -----------------------------------------------------------------------

    async def _get(self, analysis_id: uuid.UUID):
        found = await self._repository.get(analysis_id)
        if found is None:
            raise VideoAnalysisNotFound(analysis_id)
        return found

    @staticmethod
    def _authorize(analysis: VideoAnalysis, user: User) -> None:
        if analysis.created_by == user.id or user.role in CURATOR_ROLES:
            return
        raise VideoAnalysisForbidden(analysis.id)

    def _build(
        self, payload: VideoAnalysisCreate, user: User
    ) -> tuple[VideoAnalysis, list[VideoAnalysisPothole]]:
        """The rows to insert, with a storage key for every object that will be offered.

        Keys are fixed here, once: a repeated create re-signs the same keys, so a retried
        upload overwrites its own partial object instead of leaving an orphan.
        """
        key = ObjectStorage.build_video_analysis_key
        uploaded = payload.source == "upload"
        analysis = VideoAnalysis(
            id=payload.id,
            created_by=user.id,
            title=payload.title,
            file_name=payload.file_name,
            source=payload.source,
            demo_video_path=None if uploaded else payload.video_url,
            demo_poster_path=None if uploaded else payload.poster_url,
            video_content_type=payload.video_content_type,
            recorded_at=payload.recorded_at,
            duration_seconds=payload.duration_seconds,
            width=payload.width,
            height=payload.height,
            model_version=payload.model_version,
            confidence_threshold=payload.confidence_threshold,
            sample_fps=payload.sample_fps,
            frames_analysed=payload.frames_analysed,
            raw_detections=payload.raw_detections,
            rejected_tracks=payload.rejected_tracks,
            average_inference_ms=payload.average_inference_ms,
            overlay_key=key(
                analysis_id=payload.id, kind="overlay", content_type=OVERLAY_CONTENT_TYPE
            ),
            poster_key=(
                key(analysis_id=payload.id, kind="poster", content_type=VIDEO_ANALYSIS_IMAGE_TYPE)
                if uploaded
                else None
            ),
            video_key=(
                key(analysis_id=payload.id, kind="video", content_type=payload.video_content_type)
                if uploaded and payload.video_content_type
                else None
            ),
        )

        potholes = []
        for item in payload.potholes:
            pothole_id = uuid.uuid4()
            potholes.append(
                VideoAnalysisPothole(
                    id=pothole_id,
                    analysis_id=payload.id,
                    track_id=item.track_id,
                    first_seen_seconds=item.first_seen_seconds,
                    last_seen_seconds=item.last_seen_seconds,
                    best_frame_seconds=item.best_frame_seconds,
                    confidence=item.confidence,
                    severity=item.severity,
                    severity_score=item.severity_score,
                    severity_confidence=item.severity_confidence,
                    observation_count=item.observation_count,
                    max_area=item.max_area,
                    crop_key=self._image_key(payload.id, pothole_id, "crop", item.has_crop),
                    full_key=self._image_key(payload.id, pothole_id, "full", item.has_full),
                )
            )
        return analysis, potholes

    @staticmethod
    def _image_key(
        analysis_id: uuid.UUID, pothole_id: uuid.UUID, kind: str, wanted: bool
    ) -> str | None:
        if not wanted:
            return None
        return ObjectStorage.build_video_analysis_key(
            analysis_id=analysis_id,
            kind=kind,
            content_type=VIDEO_ANALYSIS_IMAGE_TYPE,
            pothole_id=pothole_id,
        )

    def _created(
        self,
        analysis: VideoAnalysis,
        latitude: float | None,
        longitude: float | None,
        potholes: list[VideoAnalysisPothole],
    ) -> VideoAnalysisCreated:
        return VideoAnalysisCreated(
            analysis=self._detail(analysis, latitude, longitude, potholes),
            uploads=self._uploads(analysis, potholes),
        )

    def _uploads(
        self, analysis: VideoAnalysis, potholes: list[VideoAnalysisPothole]
    ) -> VideoAnalysisUploads:
        def image(key: str | None, uploaded_at: datetime | None) -> UploadTarget | None:
            return self._target(key, uploaded_at, VIDEO_ANALYSIS_IMAGE_TYPE, "image")

        return VideoAnalysisUploads(
            overlay=self._target(
                analysis.overlay_key, analysis.overlay_uploaded_at, OVERLAY_CONTENT_TYPE, "overlay"
            ),
            poster=image(analysis.poster_key, analysis.poster_uploaded_at),
            video=self._target(
                analysis.video_key, analysis.video_uploaded_at, analysis.video_content_type, "video"
            ),
            potholes={
                pothole.track_id: VideoPotholeUploads(
                    crop=image(pothole.crop_key, pothole.crop_uploaded_at),
                    full=image(pothole.full_key, pothole.full_uploaded_at),
                )
                for pothole in potholes
            },
        )

    def _target(
        self,
        key: str | None,
        uploaded_at: datetime | None,
        content_type: str | None,
        kind: str,
    ) -> UploadTarget | None:
        """A signed form for an object that was offered and is not yet uploaded."""
        if key is None or uploaded_at is not None or content_type is None:
            return None
        try:
            form = self._storage.presign_upload(key, content_type, kind=kind)
        except Exception:
            # Storage misconfiguration must not lose the analysis, which is already
            # committed. The object is not marked, so a repeated create offers it again.
            return None
        return UploadTarget(
            key=key,
            url=form.url,
            fields=form.fields,
            expires_in_seconds=self._settings.upload_url_ttl_seconds,
        )

    def _read_url(self, key: str) -> str | None:
        """A read link, long enough to watch a whole video; nothing if signing fails.

        Signing is local arithmetic, but a misconfigured storage endpoint must cost the
        picture, never the page.
        """
        try:
            return self._storage.presign_get(key, expires_in=self._settings.media_url_ttl_seconds)
        except Exception:
            return None

    def _stored(self, key: str | None, uploaded_at: datetime | None) -> str | None:
        """The read link for an object, only once it is marked uploaded."""
        if key is None or uploaded_at is None:
            return None
        return self._read_url(key)

    def _poster_url(self, analysis: VideoAnalysis) -> str | None:
        if analysis.source == "demo":
            return analysis.demo_poster_path
        return self._stored(analysis.poster_key, analysis.poster_uploaded_at)

    def _video_url(self, analysis: VideoAnalysis) -> str | None:
        if analysis.source == "demo":
            return analysis.demo_video_path
        return self._stored(analysis.video_key, analysis.video_uploaded_at)

    @staticmethod
    def _location(
        analysis: VideoAnalysis, latitude: float | None, longitude: float | None
    ) -> VideoLocationOut | None:
        if latitude is None or longitude is None or analysis.location_accuracy_m is None:
            return None
        return VideoLocationOut(
            latitude=latitude,
            longitude=longitude,
            accuracy_m=float(analysis.location_accuracy_m),
            label=analysis.location_label,
            source=analysis.location_source or MANUAL_SOURCE,
        )

    def _summary_fields(
        self,
        analysis: VideoAnalysis,
        latitude: float | None,
        longitude: float | None,
        counts: dict[str, int],
    ) -> dict[str, Any]:
        return {
            "id": analysis.id,
            "title": analysis.title,
            "file_name": analysis.file_name,
            "source": analysis.source,
            "created_at": analysis.created_at,
            "recorded_at": analysis.recorded_at,
            "duration_seconds": analysis.duration_seconds,
            "poster_url": self._poster_url(analysis),
            "pothole_count": sum(counts.values()),
            "severity_counts": SeverityCounts(**counts),
            "location": self._location(analysis, latitude, longitude),
            "model_version": analysis.model_version,
            "confidence_threshold": analysis.confidence_threshold,
        }

    def _summary(
        self,
        analysis: VideoAnalysis,
        latitude: float | None,
        longitude: float | None,
        counts: dict[str, int],
    ) -> VideoAnalysisSummary:
        return VideoAnalysisSummary(**self._summary_fields(analysis, latitude, longitude, counts))

    def _detail(
        self,
        analysis: VideoAnalysis,
        latitude: float | None,
        longitude: float | None,
        potholes: list[VideoAnalysisPothole],
    ) -> VideoAnalysisDetail:
        counts: dict[str, int] = {}
        for pothole in potholes:
            counts[pothole.severity] = counts.get(pothole.severity, 0) + 1
        # Clip order in every answer, including a create's, whose rows are in payload order.
        in_clip_order = sorted(potholes, key=lambda item: (item.first_seen_seconds, item.track_id))
        return VideoAnalysisDetail(
            **self._summary_fields(analysis, latitude, longitude, counts),
            video_url=self._video_url(analysis),
            overlay_url=self._stored(analysis.overlay_key, analysis.overlay_uploaded_at),
            width=analysis.width,
            height=analysis.height,
            sample_fps=analysis.sample_fps,
            frames_analysed=analysis.frames_analysed,
            raw_detections=analysis.raw_detections,
            rejected_tracks=analysis.rejected_tracks,
            average_inference_ms=analysis.average_inference_ms,
            potholes=[VideoPotholeOut(**self._pothole_fields(item)) for item in in_clip_order],
        )

    def _pothole_fields(self, pothole: VideoAnalysisPothole) -> dict[str, Any]:
        return {
            "id": pothole.id,
            "track_id": pothole.track_id,
            "first_seen_seconds": pothole.first_seen_seconds,
            "last_seen_seconds": pothole.last_seen_seconds,
            "best_frame_seconds": pothole.best_frame_seconds,
            "confidence": pothole.confidence,
            "severity": pothole.severity,
            "severity_score": pothole.severity_score,
            "severity_confidence": pothole.severity_confidence,
            "observation_count": pothole.observation_count,
            "max_area": pothole.max_area,
            "crop_url": self._stored(pothole.crop_key, pothole.crop_uploaded_at),
            "full_url": self._stored(pothole.full_key, pothole.full_uploaded_at),
        }
