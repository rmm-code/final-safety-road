"""Payloads, requests and rows shared by the saved video analysis tests."""

from __future__ import annotations

import uuid

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import VideoAnalysis, VideoAnalysisPothole

LAT, LON = 41.3112, 69.2797

SUMMARY_KEYS = {
    "id",
    "title",
    "fileName",
    "source",
    "createdAt",
    "recordedAt",
    "durationSeconds",
    "posterUrl",
    "potholeCount",
    "severityCounts",
    "location",
    "modelVersion",
    "confidenceThreshold",
}
DETAIL_KEYS = SUMMARY_KEYS | {
    "videoUrl",
    "overlayUrl",
    "width",
    "height",
    "sampleFps",
    "framesAnalysed",
    "rawDetections",
    "rejectedTracks",
    "averageInferenceMs",
    "potholes",
}
POTHOLE_KEYS = {
    "id",
    "trackId",
    "firstSeenSeconds",
    "lastSeenSeconds",
    "bestFrameSeconds",
    "confidence",
    "severity",
    "severityScore",
    "severityConfidence",
    "observationCount",
    "maxArea",
    "cropUrl",
    "fullUrl",
}
GALLERY_KEYS = POTHOLE_KEYS | {"analysisId", "analysisTitle", "located"}
LOCATED_KEYS = {
    "id",
    "title",
    "latitude",
    "longitude",
    "accuracyM",
    "label",
    "potholeCount",
    "posterUrl",
    "thumbnails",
}
# `source` is the one addition to the contract: a hand-placed point says so.
LOCATION_KEYS = {"latitude", "longitude", "accuracyM", "label", "source"}
# The existing evidence-photo shape, snake_case included - the web already parses it.
TARGET_KEYS = {"key", "url", "fields", "method", "expires_in_seconds"}

BBOX_AROUND = f"{LON - 0.01},{LAT - 0.01},{LON + 0.01},{LAT + 0.01}"


def pothole(track_id: str, **overrides) -> dict:
    body = {
        "trackId": track_id,
        "firstSeenSeconds": 3.0,
        "lastSeenSeconds": 4.5,
        "bestFrameSeconds": 4.0,
        "confidence": 0.81,
        "severity": "large",
        "severityScore": 0.7,
        "severityConfidence": 0.6,
        "observationCount": 14,
        "maxArea": 0.031,
        "hasCrop": True,
        "hasFull": True,
    }
    body.update(overrides)
    return body


def analysis_payload(**overrides) -> dict:
    """An uploaded clip with two potholes, both with a crop and a full frame."""
    body = {
        "id": str(uuid.uuid4()),
        "title": "Chilonzor, morning run",
        "fileName": "chilonzor-0710.mp4",
        "source": "upload",
        "videoUrl": None,
        "posterUrl": None,
        "videoContentType": "video/mp4",
        "recordedAt": "2026-10-10T07:10:00Z",
        "durationSeconds": 42.5,
        "width": 1280,
        "height": 720,
        "modelVersion": "pothole-detector-0.1.0",
        "confidenceThreshold": 0.35,
        "sampleFps": 12,
        "framesAnalysed": 510,
        "rawDetections": 37,
        "rejectedTracks": 4,
        "averageInferenceMs": 180.5,
        "potholes": [
            pothole("track-1", firstSeenSeconds=3.0, lastSeenSeconds=4.5),
            pothole(
                "track-2",
                firstSeenSeconds=12.25,
                lastSeenSeconds=13.0,
                bestFrameSeconds=12.5,
                severity="small",
                severityScore=0.2,
            ),
        ],
    }
    body.update(overrides)
    return body


def demo_payload(**overrides) -> dict:
    body = analysis_payload(
        source="demo",
        videoUrl="/demo/video-1.mp4",
        posterUrl="/demo/video-1.jpg",
        videoContentType=None,
        title="Demo clip 1",
        fileName="video-1.mp4",
    )
    body.update(overrides)
    return body


async def create(client: AsyncClient, auth, payload: dict | None = None, expect: int = 201):
    response = await client.post(
        "/api/v1/video-analyses", json=payload or analysis_payload(), headers=auth
    )
    assert response.status_code == expect, response.text
    return response.json()


async def complete(client: AsyncClient, auth, analysis_id: str, **marks) -> dict:
    response = await client.post(
        f"/api/v1/video-analyses/{analysis_id}/complete", json=marks, headers=auth
    )
    assert response.status_code == 200, response.text
    return response.json()


async def place(client: AsyncClient, auth, analysis_id: str, **location) -> dict:
    body = {"latitude": LAT, "longitude": LON, "accuracyM": 50.0, "label": "Bunyodkor av."}
    body.update(location)
    response = await client.put(
        f"/api/v1/video-analyses/{analysis_id}/location", json=body, headers=auth
    )
    assert response.status_code == 200, response.text
    return response.json()


async def detail(client: AsyncClient, auth, analysis_id: str) -> dict:
    response = await client.get(f"/api/v1/video-analyses/{analysis_id}", headers=auth)
    assert response.status_code == 200, response.text
    return response.json()


def by_track(analysis: dict) -> dict[str, dict]:
    return {item["trackId"]: item for item in analysis["potholes"]}


async def count(db: AsyncSession, model) -> int:
    return int(await db.scalar(select(func.count()).select_from(model)))


def analysis_row(analysis_id: uuid.UUID, **overrides) -> VideoAnalysis:
    """A row inserted directly, bypassing the API."""
    values = dict(
        id=analysis_id,
        title="clip",
        file_name="clip.mp4",
        source="upload",
        duration_seconds=10.0,
        width=1280,
        height=720,
        model_version="pothole-detector-0.1.0",
        confidence_threshold=0.35,
        sample_fps=12.0,
        frames_analysed=120,
        raw_detections=0,
        rejected_tracks=0,
        average_inference_ms=100.0,
    )
    values.update(overrides)
    return VideoAnalysis(**values)


def pothole_row(analysis_id: uuid.UUID, track_id: str) -> VideoAnalysisPothole:
    return VideoAnalysisPothole(
        id=uuid.uuid4(),
        analysis_id=analysis_id,
        track_id=track_id,
        first_seen_seconds=1.0,
        last_seen_seconds=2.0,
        confidence=0.8,
        severity="medium",
        severity_score=0.5,
        severity_confidence=0.5,
        observation_count=3,
        max_area=0.01,
    )
