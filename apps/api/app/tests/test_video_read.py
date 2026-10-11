"""Reading saved analyses back, and marking their uploads finished."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import VideoAnalysis
from app.tests.video_helpers import (
    DETAIL_KEYS,
    POTHOLE_KEYS,
    SUMMARY_KEYS,
    analysis_payload,
    by_track,
    complete,
    create,
    demo_payload,
    detail,
    pothole,
)


class TestReadingBack:
    async def test_the_list_describes_each_analysis(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        response = await client.get("/api/v1/video-analyses", headers=auth)

        assert response.status_code == 200
        assert set(response.json()) == {"items"}
        [item] = response.json()["items"]
        assert set(item) == SUMMARY_KEYS
        assert item["id"] == payload["id"]
        assert item["title"] == payload["title"]
        assert item["fileName"] == payload["fileName"]
        assert item["source"] == "upload"
        assert item["recordedAt"].startswith("2026-10-10T07:10:00")
        assert item["durationSeconds"] == 42.5
        assert item["potholeCount"] == 2
        assert item["severityCounts"] == {"small": 1, "medium": 0, "large": 1, "unknown": 0}
        assert item["location"] is None
        assert item["posterUrl"] is None  # not uploaded yet
        assert item["modelVersion"] == "pothole-detector-0.1.0"
        assert item["confidenceThreshold"] == 0.35

    async def test_the_list_is_newest_first(self, client: AsyncClient, auth, db: AsyncSession):
        ids = []
        for hours_ago in (5, 1, 3):
            payload = analysis_payload(title=f"{hours_ago} hours ago")
            await create(client, auth, payload)
            await db.execute(
                update(VideoAnalysis)
                .where(VideoAnalysis.id == uuid.UUID(payload["id"]))
                .values(created_at=datetime.now(UTC) - timedelta(hours=hours_ago))
            )
            ids.append(payload["id"])
        await db.commit()

        items = (await client.get("/api/v1/video-analyses", headers=auth)).json()["items"]

        assert [item["title"] for item in items] == ["1 hours ago", "3 hours ago", "5 hours ago"]

    async def test_the_list_returns_at_most_200(self, client: AsyncClient, auth, db: AsyncSession):
        now = datetime.now(UTC)
        db.add_all(
            VideoAnalysis(
                id=uuid.uuid4(),
                title=f"clip {i}",
                file_name=f"clip-{i}.mp4",
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
                created_at=now - timedelta(minutes=i),
            )
            for i in range(205)
        )
        await db.commit()

        items = (await client.get("/api/v1/video-analyses", headers=auth)).json()["items"]

        assert len(items) == 200
        assert items[0]["title"] == "clip 0"

    async def test_the_detail_carries_everything_the_replay_needs(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        body = await detail(client, auth, payload["id"])

        assert set(body) == DETAIL_KEYS
        assert body["width"] == 1280 and body["height"] == 720
        assert body["sampleFps"] == 12
        assert body["framesAnalysed"] == 510
        assert body["rawDetections"] == 37
        assert body["rejectedTracks"] == 4
        assert body["averageInferenceMs"] == 180.5
        # Nothing has finished uploading, so nothing is offered for playback.
        assert body["videoUrl"] is None
        assert body["overlayUrl"] is None
        assert body["posterUrl"] is None

        assert [item["trackId"] for item in body["potholes"]] == ["track-1", "track-2"]
        for item in body["potholes"]:
            assert set(item) == POTHOLE_KEYS
            assert item["cropUrl"] is None and item["fullUrl"] is None
        second = by_track(body)["track-2"]
        assert second["firstSeenSeconds"] == 12.25
        assert second["lastSeenSeconds"] == 13.0
        assert second["bestFrameSeconds"] == 12.5
        assert second["confidence"] == 0.81
        assert second["severity"] == "small"
        assert second["severityScore"] == 0.2
        assert second["severityConfidence"] == 0.6
        assert second["observationCount"] == 14
        assert second["maxArea"] == 0.031

    async def test_potholes_are_in_clip_order(self, client: AsyncClient, auth):
        payload = analysis_payload(
            potholes=[
                pothole("late", firstSeenSeconds=30.0, lastSeenSeconds=31.0),
                pothole("early", firstSeenSeconds=1.0, lastSeenSeconds=2.0),
                pothole("middle", firstSeenSeconds=10.0, lastSeenSeconds=11.0),
            ]
        )
        created = await create(client, auth, payload)

        body = await detail(client, auth, payload["id"])

        assert [item["trackId"] for item in body["potholes"]] == ["early", "middle", "late"]
        # The create's own answer agrees with every later read.
        in_answer = [item["trackId"] for item in created["analysis"]["potholes"]]
        assert in_answer == ["early", "middle", "late"]

    async def test_an_unknown_analysis_is_404(self, client: AsyncClient, auth):
        response = await client.get(f"/api/v1/video-analyses/{uuid.uuid4()}", headers=auth)
        assert response.status_code == 404

    async def test_every_user_sees_every_analysis(self, client: AsyncClient, auth, other_auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        items = (await client.get("/api/v1/video-analyses", headers=other_auth)).json()["items"]
        assert [item["id"] for item in items] == [payload["id"]]
        assert (await detail(client, other_auth, payload["id"]))["id"] == payload["id"]

    async def test_reading_requires_authentication(self, client: AsyncClient):
        assert (await client.get("/api/v1/video-analyses")).status_code == 401
        assert (await client.get("/api/v1/video-potholes")).status_code == 401


class TestCompletion:
    async def test_urls_appear_only_once_an_upload_is_marked(self, client: AsyncClient, auth):
        payload = analysis_payload()
        created = (await create(client, auth, payload))["uploads"]

        marked = await complete(
            client,
            auth,
            payload["id"],
            overlay=True,
            poster=True,
            video=True,
            crops=["track-1"],
            fulls=["track-2"],
        )

        assert set(marked) == DETAIL_KEYS
        assert created["overlay"]["key"] in marked["overlayUrl"]
        assert created["video"]["key"] in marked["videoUrl"]
        assert created["poster"]["key"] in marked["posterUrl"]
        tracks = by_track(marked)
        assert created["potholes"]["track-1"]["crop"]["key"] in tracks["track-1"]["cropUrl"]
        assert tracks["track-1"]["fullUrl"] is None
        assert tracks["track-2"]["cropUrl"] is None
        assert created["potholes"]["track-2"]["full"]["key"] in tracks["track-2"]["fullUrl"]

        # The same state on a fresh read and in the list.
        again = await detail(client, auth, payload["id"])
        assert again["videoUrl"] is not None and again["overlayUrl"] is not None
        [summary] = (await client.get("/api/v1/video-analyses", headers=auth)).json()["items"]
        assert created["poster"]["key"] in summary["posterUrl"]

    async def test_an_unfinished_video_reads_as_not_stored(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        body = await complete(client, auth, payload["id"], overlay=True)

        assert body["overlayUrl"] is not None
        assert body["videoUrl"] is None
        assert body["posterUrl"] is None

    async def test_completion_never_unmarks(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)
        await complete(client, auth, payload["id"], overlay=True, crops=["track-1"])

        body = await complete(client, auth, payload["id"], overlay=False, crops=[])

        assert body["overlayUrl"] is not None
        assert by_track(body)["track-1"]["cropUrl"] is not None

    async def test_marks_for_objects_never_offered_are_ignored(self, client: AsyncClient, auth):
        payload = demo_payload(potholes=[pothole("track-1", hasCrop=False, hasFull=True)])
        await create(client, auth, payload)

        body = await complete(
            client,
            auth,
            payload["id"],
            video=True,
            poster=True,
            crops=["track-1", "no-such-track"],
            fulls=["no-such-track"],
        )

        # A demo clip's video and poster are the web app's own files, not storage objects.
        assert body["videoUrl"] == "/demo/video-1.mp4"
        assert body["posterUrl"] == "/demo/video-1.jpg"
        assert by_track(body)["track-1"]["cropUrl"] is None

    async def test_an_empty_completion_changes_nothing(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        body = await complete(client, auth, payload["id"])

        assert body["overlayUrl"] is None and body["videoUrl"] is None

    async def test_completing_an_unknown_analysis_is_404(self, client: AsyncClient, auth):
        response = await client.post(
            f"/api/v1/video-analyses/{uuid.uuid4()}/complete", json={"overlay": True}, headers=auth
        )
        assert response.status_code == 404

    async def test_only_the_uploader_marks_uploads(self, client: AsyncClient, auth, other_auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        response = await client.post(
            f"/api/v1/video-analyses/{payload['id']}/complete",
            json={"overlay": True},
            headers=other_auth,
        )

        assert response.status_code == 403
        assert (await detail(client, auth, payload["id"]))["overlayUrl"] is None

    async def test_an_operator_may_mark_uploads(self, client: AsyncClient, auth, operator_auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        body = await complete(client, operator_auth, payload["id"], overlay=True)
        assert body["overlayUrl"] is not None
