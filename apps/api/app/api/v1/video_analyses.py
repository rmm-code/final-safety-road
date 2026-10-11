"""Saved video analyses: the Videos page, the replay page, the map layer and the gallery.

A road video is analysed in the visitor's browser; the finished analysis is saved here so
everyone sees it. The browser uploads the overlay, poster, video and pothole photos
straight to storage through the targets `POST` returns, then reports what finished.

Placing a video on the map stores a hand-placed point on the analysis and nothing else: no
sightings, no potholes, no dedup.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.api.deps import CurrentUser, DbDep, SettingsDep, rate_limit
from app.api.v1.potholes import MAX_BBOX_SPAN_DEG
from app.schemas.video_analysis import (
    LocatedVideoAnalysisList,
    VideoAnalysisComplete,
    VideoAnalysisCreate,
    VideoAnalysisCreated,
    VideoAnalysisDetail,
    VideoAnalysisList,
    VideoLocationIn,
    VideoPotholeGallery,
)
from app.services.video_analyses import (
    VideoAnalysisError,
    VideoAnalysisForbidden,
    VideoAnalysisIdTaken,
    VideoAnalysisNotFound,
    VideoAnalysisService,
)

router = APIRouter(
    prefix="/video-analyses", tags=["video-analyses"], dependencies=[Depends(rate_limit)]
)
# Every pothole photo from every saved video, for the Potholes page.
gallery_router = APIRouter(
    prefix="/video-potholes", tags=["video-analyses"], dependencies=[Depends(rate_limit)]
)


def _http_error(error: VideoAnalysisError) -> HTTPException:
    if isinstance(error, VideoAnalysisNotFound):
        return HTTPException(status.HTTP_404_NOT_FOUND, "Video analysis not found")
    if isinstance(error, VideoAnalysisForbidden):
        return HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Only whoever saved this analysis, an operator or an admin may change it",
        )
    if isinstance(error, VideoAnalysisIdTaken):
        return HTTPException(status.HTTP_409_CONFLICT, "Video analysis id is taken")
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(error))


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    """The internal map's viewport rules: four numbers, not inverted, capped in span."""
    try:
        min_lng, min_lat, max_lng, max_lat = (float(part) for part in bbox.split(","))
    except ValueError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "bbox must be minLng,minLat,maxLng,maxLat"
        ) from error
    if min_lng >= max_lng or min_lat >= max_lat:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "bbox is empty or inverted")
    if (max_lng - min_lng) > MAX_BBOX_SPAN_DEG or (max_lat - min_lat) > MAX_BBOX_SPAN_DEG:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"bbox may span at most {MAX_BBOX_SPAN_DEG} degrees; zoom in",
        )
    return min_lng, min_lat, max_lng, max_lat


@router.post("", response_model=VideoAnalysisCreated, status_code=status.HTTP_201_CREATED)
async def create_video_analysis(
    payload: VideoAnalysisCreate,
    db: DbDep,
    user: CurrentUser,
    settings: SettingsDep,
    response: Response,
) -> VideoAnalysisCreated:
    """Save a finished analysis. Idempotent on the client's `id`.

    201 when saved now, 200 when the id was already saved - with fresh upload targets for
    whatever has not been marked uploaded, so an interrupted upload can be finished.
    """
    try:
        result = await VideoAnalysisService(db, settings).create(payload, user)
    except VideoAnalysisError as error:
        raise _http_error(error) from error
    if not result.created:
        response.status_code = status.HTTP_200_OK
    return result.body


@router.get("", response_model=VideoAnalysisList)
async def list_video_analyses(
    db: DbDep, _user: CurrentUser, settings: SettingsDep
) -> VideoAnalysisList:
    """Every saved analysis, newest first, at most 200."""
    return await VideoAnalysisService(db, settings).recent()


# Declared before `/{analysis_id}`, which would otherwise take "located" for an id.
@router.get("/located", response_model=LocatedVideoAnalysisList)
async def located_video_analyses(
    db: DbDep,
    _user: CurrentUser,
    settings: SettingsDep,
    bbox: str = Query(description="minLng,minLat,maxLng,maxLat"),
) -> LocatedVideoAnalysisList:
    """Placed videos inside a map viewport, each with up to four pothole crops."""
    min_lng, min_lat, max_lng, max_lat = _parse_bbox(bbox)
    return await VideoAnalysisService(db, settings).located(
        min_lng=min_lng, min_lat=min_lat, max_lng=max_lng, max_lat=max_lat
    )


@router.get("/{analysis_id}", response_model=VideoAnalysisDetail)
async def get_video_analysis(
    analysis_id: uuid.UUID, db: DbDep, _user: CurrentUser, settings: SettingsDep
) -> VideoAnalysisDetail:
    try:
        return await VideoAnalysisService(db, settings).detail(analysis_id)
    except VideoAnalysisError as error:
        raise _http_error(error) from error


@router.post("/{analysis_id}/complete", response_model=VideoAnalysisDetail)
async def complete_video_analysis_uploads(
    analysis_id: uuid.UUID,
    payload: VideoAnalysisComplete,
    db: DbDep,
    user: CurrentUser,
    settings: SettingsDep,
) -> VideoAnalysisDetail:
    """Mark which uploads finished. True or listed means uploaded; nothing is un-marked."""
    try:
        return await VideoAnalysisService(db, settings).complete(analysis_id, payload, user)
    except VideoAnalysisError as error:
        raise _http_error(error) from error


@router.put("/{analysis_id}/location", response_model=VideoAnalysisDetail)
async def set_video_analysis_location(
    analysis_id: uuid.UUID,
    payload: VideoLocationIn,
    db: DbDep,
    user: CurrentUser,
    settings: SettingsDep,
) -> VideoAnalysisDetail:
    """Place the video on the map by hand. Stored as "manual"; creates no sightings."""
    try:
        return await VideoAnalysisService(db, settings).set_location(analysis_id, payload, user)
    except VideoAnalysisError as error:
        raise _http_error(error) from error


@router.delete("/{analysis_id}/location", response_model=VideoAnalysisDetail)
async def clear_video_analysis_location(
    analysis_id: uuid.UUID, db: DbDep, user: CurrentUser, settings: SettingsDep
) -> VideoAnalysisDetail:
    try:
        return await VideoAnalysisService(db, settings).clear_location(analysis_id, user)
    except VideoAnalysisError as error:
        raise _http_error(error) from error


@gallery_router.get("", response_model=VideoPotholeGallery)
async def list_video_potholes(
    db: DbDep,
    _user: CurrentUser,
    settings: SettingsDep,
    limit: int = Query(default=60, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> VideoPotholeGallery:
    """Every pothole from every saved video: newest analysis first, then in clip order."""
    return await VideoAnalysisService(db, settings).pothole_gallery(limit=limit, offset=offset)
