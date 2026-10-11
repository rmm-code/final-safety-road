"""Saving a video analysis: idempotent on the client's id, and validated."""

from __future__ import annotations

import asyncio
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import VideoAnalysis
from app.repositories.video_analyses import VideoAnalysisRepository
from app.tests.video_helpers import (
    TARGET_KEYS,
    analysis_payload,
    analysis_row,
    complete,
    count,
    create,
    demo_payload,
    detail,
    pothole,
    pothole_row,
)


class TestCreate:
    async def test_create_returns_the_analysis_and_a_target_for_every_object(
        self, client: AsyncClient, auth
    ):
        payload = analysis_payload()
        body = await create(client, auth, payload)

        assert set(body) == {"analysis", "uploads"}
        assert body["analysis"]["id"] == payload["id"]
        uploads = body["uploads"]
        assert set(uploads) == {"overlay", "poster", "video", "potholes"}
        prefix = f"video-analyses/{payload['id']}/"
        expected_types = {
            "overlay": "application/json",
            "poster": "image/jpeg",
            "video": "video/mp4",
        }
        for name, content_type in expected_types.items():
            target = uploads[name]
            assert set(target) == TARGET_KEYS, name
            assert target["method"] == "POST"
            assert target["key"].startswith(prefix)
            assert target["fields"]["key"] == target["key"]
            assert target["fields"]["Content-Type"] == content_type
            assert target["expires_in_seconds"] > 0
        assert uploads["video"]["key"].endswith(".mp4")

        assert set(uploads["potholes"]) == {"track-1", "track-2"}
        keys = set()
        for track in ("track-1", "track-2"):
            for kind in ("crop", "full"):
                target = uploads["potholes"][track][kind]
                assert target["fields"]["Content-Type"] == "image/jpeg"
                assert target["key"].startswith(prefix)
                keys.add(target["key"])
        # Four distinct objects; the client's track id never becomes part of a key.
        assert len(keys) == 4
        assert not any("track-" in key for key in keys)

    async def test_a_repeated_create_returns_200_and_the_same_analysis(
        self, client: AsyncClient, auth, db: AsyncSession
    ):
        payload = analysis_payload()
        first = await create(client, auth, payload)
        second = await create(client, auth, payload, expect=200)

        assert second["analysis"]["id"] == first["analysis"]["id"]
        assert second["analysis"]["createdAt"] == first["analysis"]["createdAt"]
        assert len(second["analysis"]["potholes"]) == 2
        assert await count(db, VideoAnalysis) == 1

    async def test_a_repeated_create_offers_targets_only_for_what_is_not_uploaded(
        self, client: AsyncClient, auth
    ):
        payload = analysis_payload()
        first = await create(client, auth, payload)
        await complete(client, auth, payload["id"], overlay=True, video=True, crops=["track-1"])

        uploads = (await create(client, auth, payload, expect=200))["uploads"]

        # Finished uploads are left alone; the rest get fresh targets for the same keys,
        # so an interrupted upload can simply be retried.
        assert uploads["overlay"] is None
        assert uploads["video"] is None
        assert uploads["poster"]["key"] == first["uploads"]["poster"]["key"]
        assert uploads["potholes"]["track-1"]["crop"] is None
        assert (
            uploads["potholes"]["track-1"]["full"]["key"]
            == first["uploads"]["potholes"]["track-1"]["full"]["key"]
        )
        assert uploads["potholes"]["track-2"]["crop"] is not None
        assert uploads["potholes"]["track-2"]["full"] is not None

    async def test_a_repeated_create_after_everything_uploaded_offers_nothing(
        self, client: AsyncClient, auth
    ):
        payload = analysis_payload()
        await create(client, auth, payload)
        await complete(
            client,
            auth,
            payload["id"],
            overlay=True,
            poster=True,
            video=True,
            crops=["track-1", "track-2"],
            fulls=["track-1", "track-2"],
        )

        uploads = (await create(client, auth, payload, expect=200))["uploads"]

        assert uploads["overlay"] is None and uploads["poster"] is None
        assert uploads["video"] is None
        assert uploads["potholes"] == {
            "track-1": {"crop": None, "full": None},
            "track-2": {"crop": None, "full": None},
        }

    async def test_two_simultaneous_creates_save_one_analysis(
        self, client: AsyncClient, auth, db: AsyncSession
    ):
        # A browser that retries before its first attempt answered.
        payload = analysis_payload()
        first, second = await asyncio.gather(
            client.post("/api/v1/video-analyses", json=payload, headers=auth),
            client.post("/api/v1/video-analyses", json=payload, headers=auth),
        )

        assert sorted([first.status_code, second.status_code]) == [200, 201]
        assert await count(db, VideoAnalysis) == 1
        assert len((await detail(client, auth, payload["id"]))["potholes"]) == 2

    async def test_losing_the_insert_race_reads_as_already_saved(self, engine, db: AsyncSession):
        # The path the simultaneous-create test may or may not reach, forced: the id is
        # committed by someone else between this session's lookup and its insert.
        analysis_id = uuid.uuid4()
        db.add(analysis_row(analysis_id, title="the winner"))
        await db.commit()

        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            repository = VideoAnalysisRepository(session)
            inserted = await repository.add_unless_exists(
                analysis_row(analysis_id, title="the loser"),
                [pothole_row(analysis_id, "track-1")],
            )

            assert inserted is False
            # The savepoint confined the failure: the session still works, and the row
            # it finds is the winner's.
            found = await repository.get(analysis_id)
            assert found is not None and found[0].title == "the winner"
            assert await repository.potholes(analysis_id) == []

    async def test_an_unrelated_integrity_error_is_not_swallowed(self, engine):
        # Only "this id is already saved" means a lost race. Anything else must surface.
        analysis_id = uuid.uuid4()
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            with pytest.raises(IntegrityError):
                await VideoAnalysisRepository(session).add_unless_exists(
                    analysis_row(analysis_id, title="duplicate tracks"),
                    [pothole_row(analysis_id, "track-1"), pothole_row(analysis_id, "track-1")],
                )

    async def test_another_users_id_is_not_adopted(self, client: AsyncClient, auth, other_auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        # Otherwise anyone who learned an id could upload into someone else's analysis.
        response = await client.post("/api/v1/video-analyses", json=payload, headers=other_auth)
        assert response.status_code == 409

    async def test_a_demo_clip_gets_no_video_or_poster_target(self, client: AsyncClient, auth):
        body = await create(client, auth, demo_payload())

        assert body["uploads"]["video"] is None
        assert body["uploads"]["poster"] is None
        assert body["uploads"]["overlay"] is not None
        # The web app serves the demo files itself, so their paths are usable at once.
        assert body["analysis"]["videoUrl"] == "/demo/video-1.mp4"
        assert body["analysis"]["posterUrl"] == "/demo/video-1.jpg"
        assert body["analysis"]["source"] == "demo"

    async def test_a_demo_clip_may_have_no_poster(self, client: AsyncClient, auth):
        body = await create(client, auth, demo_payload(posterUrl=None))
        assert body["analysis"]["posterUrl"] is None

    async def test_an_upload_that_will_not_store_its_video_gets_no_video_target(
        self, client: AsyncClient, auth
    ):
        # A clip over the size cap is analysed locally and saved without its video.
        body = await create(client, auth, analysis_payload(videoContentType=None))

        assert body["uploads"]["video"] is None
        assert body["uploads"]["poster"] is not None
        assert body["analysis"]["videoUrl"] is None

    async def test_the_video_target_carries_the_declared_type(self, client: AsyncClient, auth):
        body = await create(client, auth, analysis_payload(videoContentType="video/quicktime"))
        video = body["uploads"]["video"]
        assert video["fields"]["Content-Type"] == "video/quicktime"
        assert video["key"].endswith(".mov")

    async def test_image_targets_only_where_the_client_has_an_image(
        self, client: AsyncClient, auth
    ):
        payload = analysis_payload(
            potholes=[
                pothole("track-1", hasCrop=True, hasFull=False),
                pothole("track-2", hasCrop=False, hasFull=False),
            ]
        )
        uploads = (await create(client, auth, payload))["uploads"]["potholes"]

        assert uploads["track-1"]["crop"] is not None
        assert uploads["track-1"]["full"] is None
        assert uploads["track-2"] == {"crop": None, "full": None}

    async def test_an_analysis_with_no_potholes_is_saved(self, client: AsyncClient, auth):
        # Four minutes of smooth road is a result too.
        body = await create(client, auth, analysis_payload(potholes=[]))
        assert body["analysis"]["potholeCount"] == 0
        assert body["uploads"]["potholes"] == {}

    async def test_creating_requires_authentication(self, client: AsyncClient):
        response = await client.post("/api/v1/video-analyses", json=analysis_payload())
        assert response.status_code == 401


class TestValidation:
    async def test_a_synthetic_analysis_is_refused(self, client: AsyncClient, auth, db):
        # Same rule as detections: the mock engine's boxes are fabricated.
        payload = analysis_payload(modelVersion="mock-synthetic-0.1.0")
        response = await client.post("/api/v1/video-analyses", json=payload, headers=auth)

        assert response.status_code == 422
        assert "synthetic" in response.text
        assert await count(db, VideoAnalysis) == 0

    @pytest.mark.parametrize(
        "overrides",
        [
            pytest.param({"videoUrl": None}, id="demo-without-video-url"),
            pytest.param({"videoUrl": "https://evil.example/clip.mp4"}, id="absolute-url"),
            pytest.param({"videoUrl": "//evil.example/clip.mp4"}, id="protocol-relative"),
            pytest.param({"videoUrl": "/static/clip.mp4"}, id="outside-demo"),
            pytest.param({"videoUrl": "/demo/"}, id="bare-prefix"),
            pytest.param({"videoUrl": "/demo/../api/v1/potholes"}, id="dot-dot"),
            pytest.param({"videoUrl": "/demo/%2e%2e/api/v1/potholes"}, id="encoded-dot-dot"),
            pytest.param({"videoUrl": "/demo/clip.mp4\\..\\x"}, id="backslash"),
            pytest.param({"videoUrl": "javascript:alert(1)"}, id="javascript"),
            pytest.param({"posterUrl": "https://evil.example/p.jpg"}, id="poster-outside-demo"),
            pytest.param({"videoContentType": "video/mp4"}, id="demo-with-content-type"),
        ],
    )
    async def test_demo_paths_must_be_files_under_demo(
        self, client: AsyncClient, auth, overrides: dict
    ):
        response = await client.post(
            "/api/v1/video-analyses", json=demo_payload(**overrides), headers=auth
        )
        assert response.status_code == 422, response.text

    @pytest.mark.parametrize(
        "overrides",
        [
            pytest.param({"videoUrl": "/demo/video-1.mp4"}, id="upload-with-video-url"),
            pytest.param({"posterUrl": "/demo/video-1.jpg"}, id="upload-with-poster-url"),
            pytest.param({"videoContentType": "video/x-msvideo"}, id="unplayable-type"),
            pytest.param({"source": "youtube"}, id="unknown-source"),
        ],
    )
    async def test_upload_source_rules(self, client: AsyncClient, auth, overrides: dict):
        response = await client.post(
            "/api/v1/video-analyses", json=analysis_payload(**overrides), headers=auth
        )
        assert response.status_code == 422, response.text

    @pytest.mark.parametrize(
        "overrides",
        [
            pytest.param({"title": ""}, id="empty-title"),
            pytest.param({"title": "   "}, id="blank-title"),
            pytest.param({"title": "x" * 121}, id="long-title"),
            pytest.param({"fileName": ""}, id="empty-file-name"),
            pytest.param({"fileName": "x" * 256}, id="long-file-name"),
            pytest.param({"durationSeconds": 0}, id="zero-duration"),
            pytest.param({"width": 0}, id="zero-width"),
            pytest.param({"height": -1}, id="negative-height"),
            pytest.param({"confidenceThreshold": 1.5}, id="threshold-over-one"),
            pytest.param({"sampleFps": 0}, id="zero-fps"),
            pytest.param({"framesAnalysed": -1}, id="negative-frames"),
            pytest.param({"rawDetections": -1}, id="negative-detections"),
            pytest.param({"rejectedTracks": -1}, id="negative-rejected"),
            pytest.param({"averageInferenceMs": -0.1}, id="negative-inference"),
            pytest.param({"modelVersion": ""}, id="no-model-version"),
            pytest.param({"id": "not-a-uuid"}, id="bad-id"),
            pytest.param({"maxArea": 0.1}, id="unknown-field"),
        ],
    )
    async def test_out_of_range_values_are_refused(
        self, client: AsyncClient, auth, overrides: dict
    ):
        response = await client.post(
            "/api/v1/video-analyses", json=analysis_payload(**overrides), headers=auth
        )
        assert response.status_code == 422, response.text

    @pytest.mark.parametrize(
        "overrides",
        [
            pytest.param({"trackId": ""}, id="empty-track-id"),
            pytest.param({"trackId": "t" * 65}, id="long-track-id"),
            pytest.param({"confidence": 1.01}, id="confidence-over-one"),
            pytest.param({"severity": "huge"}, id="unknown-severity"),
            pytest.param({"severityScore": -0.1}, id="negative-score"),
            pytest.param({"severityConfidence": 2}, id="severity-confidence-over-one"),
            pytest.param({"observationCount": -1}, id="negative-observations"),
            pytest.param({"maxArea": -0.5}, id="negative-area"),
            pytest.param({"firstSeenSeconds": -1}, id="negative-time"),
            pytest.param({"firstSeenSeconds": 9.0, "lastSeenSeconds": 8.0}, id="ends-before-start"),
            pytest.param({"hasCrop": "maybe"}, id="not-a-bool"),
        ],
    )
    async def test_out_of_range_pothole_values_are_refused(
        self, client: AsyncClient, auth, overrides: dict
    ):
        payload = analysis_payload(potholes=[pothole("track-1", **overrides)])
        response = await client.post("/api/v1/video-analyses", json=payload, headers=auth)
        assert response.status_code == 422, response.text

    async def test_duplicate_track_ids_are_refused(self, client: AsyncClient, auth):
        # Upload targets and completion marks are addressed by track id.
        payload = analysis_payload(potholes=[pothole("track-1"), pothole("track-1")])
        response = await client.post("/api/v1/video-analyses", json=payload, headers=auth)
        assert response.status_code == 422

    async def test_at_most_500_potholes(self, client: AsyncClient, auth):
        many = [pothole(f"track-{i}") for i in range(501)]
        response = await client.post(
            "/api/v1/video-analyses", json=analysis_payload(potholes=many), headers=auth
        )
        assert response.status_code == 422

    async def test_500_potholes_are_accepted(self, client: AsyncClient, auth):
        many = [pothole(f"track-{i}", hasFull=False) for i in range(500)]
        body = await create(client, auth, analysis_payload(potholes=many))
        assert body["analysis"]["potholeCount"] == 500
        assert len(body["uploads"]["potholes"]) == 500
