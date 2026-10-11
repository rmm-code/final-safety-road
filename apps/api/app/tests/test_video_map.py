"""Placing a video on the map, the map layer and the photo gallery.

A hand-placed point for a whole clip is not a GPS fix: it never makes sightings or potholes.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DetectionEvent, Pothole, VideoAnalysis
from app.tests.video_helpers import (
    BBOX_AROUND,
    DETAIL_KEYS,
    GALLERY_KEYS,
    LAT,
    LOCATED_KEYS,
    LOCATION_KEYS,
    LON,
    analysis_payload,
    complete,
    count,
    create,
    detail,
    place,
    pothole,
)


class TestLocation:
    async def test_placing_a_video_creates_no_sightings_and_no_potholes(
        self, client: AsyncClient, auth, db: AsyncSession, drive_session_id
    ):
        # A real pothole already on the map, right where the video is about to be placed.
        sighting = await client.post(
            "/api/v1/detections",
            json={
                "clientEventId": str(uuid.uuid4()),
                "driveSessionId": drive_session_id,
                "detectedAt": datetime.now(UTC).isoformat(),
                "confidence": 0.9,
                "severity": "medium",
                "severityScore": 0.5,
                "latitude": LAT,
                "longitude": LON,
                "locationAccuracyM": 8.0,
                "modelVersion": "pothole-detector-0.1.0",
            },
            headers=auth,
        )
        assert sighting.status_code == 201, sighting.text
        before = await client.get(f"/api/v1/potholes/{sighting.json()['pothole_id']}", headers=auth)
        payload = analysis_payload()
        await create(client, auth, payload)
        events, potholes = await count(db, DetectionEvent), await count(db, Pothole)

        body = await place(client, auth, payload["id"], accuracyM=50.0, label="Bunyodkor av.")

        assert body["location"] == {
            "latitude": pytest.approx(LAT),
            "longitude": pytest.approx(LON),
            "accuracyM": 50.0,
            "label": "Bunyodkor av.",
            "source": "manual",
        }
        assert set(body["location"]) == LOCATION_KEYS
        # Two potholes in the clip, one point for all of it: nothing reaches dedup.
        assert await count(db, DetectionEvent) == events == 1
        assert await count(db, Pothole) == potholes == 1
        after = await client.get(f"/api/v1/potholes/{sighting.json()['pothole_id']}", headers=auth)
        assert after.json()["sighting_count"] == before.json()["sighting_count"] == 1
        assert after.json()["location_accuracy_m"] == before.json()["location_accuracy_m"]

    async def test_the_location_is_stored_as_hand_placed(
        self, client: AsyncClient, auth, db: AsyncSession
    ):
        payload = analysis_payload()
        await create(client, auth, payload)
        await place(client, auth, payload["id"])

        stored = await db.get(VideoAnalysis, uuid.UUID(payload["id"]))
        assert stored.location_source == "manual"
        assert stored.location_set_at is not None

    async def test_the_list_shows_the_location(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)
        await place(client, auth, payload["id"], label=None)

        [item] = (await client.get("/api/v1/video-analyses", headers=auth)).json()["items"]

        assert item["location"]["latitude"] == pytest.approx(LAT)
        assert item["location"]["label"] is None
        assert item["location"]["source"] == "manual"

    async def test_placing_again_moves_it(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)
        await place(client, auth, payload["id"])

        body = await place(client, auth, payload["id"], latitude=41.2, longitude=69.1)

        assert body["location"]["latitude"] == pytest.approx(41.2)
        assert body["location"]["longitude"] == pytest.approx(69.1)

    async def test_clearing_the_location(self, client: AsyncClient, auth, db: AsyncSession):
        payload = analysis_payload()
        await create(client, auth, payload)
        await place(client, auth, payload["id"])

        response = await client.delete(
            f"/api/v1/video-analyses/{payload['id']}/location", headers=auth
        )

        assert response.status_code == 200, response.text
        assert set(response.json()) == DETAIL_KEYS
        assert response.json()["location"] is None
        assert (await detail(client, auth, payload["id"]))["location"] is None
        stored = await db.get(VideoAnalysis, uuid.UUID(payload["id"]))
        assert stored.location is None and stored.location_source is None
        assert await count(db, DetectionEvent) == 0
        assert await count(db, Pothole) == 0

    async def test_clearing_an_unplaced_video_is_not_an_error(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        response = await client.delete(
            f"/api/v1/video-analyses/{payload['id']}/location", headers=auth
        )
        assert response.status_code == 200
        assert response.json()["location"] is None

    @pytest.mark.parametrize(
        "overrides",
        [
            pytest.param({"latitude": 90.5}, id="latitude"),
            pytest.param({"longitude": -180.5}, id="longitude"),
            pytest.param({"accuracyM": 0.5}, id="accuracy-too-good"),
            pytest.param({"accuracyM": 5001}, id="accuracy-too-poor"),
            pytest.param({"label": "x" * 121}, id="long-label"),
            pytest.param({"source": "gps"}, id="client-chosen-source"),
        ],
    )
    async def test_out_of_range_locations_are_refused(
        self, client: AsyncClient, auth, overrides: dict
    ):
        payload = analysis_payload()
        await create(client, auth, payload)
        body = {"latitude": LAT, "longitude": LON, "accuracyM": 50.0}
        body.update(overrides)

        response = await client.put(
            f"/api/v1/video-analyses/{payload['id']}/location", json=body, headers=auth
        )
        assert response.status_code == 422, response.text

    async def test_placing_an_unknown_analysis_is_404(self, client: AsyncClient, auth):
        missing = uuid.uuid4()
        put = await client.put(
            f"/api/v1/video-analyses/{missing}/location",
            json={"latitude": LAT, "longitude": LON, "accuracyM": 50.0},
            headers=auth,
        )
        delete = await client.delete(f"/api/v1/video-analyses/{missing}/location", headers=auth)
        assert put.status_code == delete.status_code == 404

    async def test_only_the_uploader_places_a_video(self, client: AsyncClient, auth, other_auth):
        payload = analysis_payload()
        await create(client, auth, payload)

        put = await client.put(
            f"/api/v1/video-analyses/{payload['id']}/location",
            json={"latitude": LAT, "longitude": LON, "accuracyM": 50.0},
            headers=other_auth,
        )
        delete = await client.delete(
            f"/api/v1/video-analyses/{payload['id']}/location", headers=other_auth
        )
        assert put.status_code == delete.status_code == 403


class TestLocatedForTheMap:
    async def test_only_placed_videos_inside_the_viewport(self, client: AsyncClient, auth):
        inside, outside, unplaced = analysis_payload(), analysis_payload(), analysis_payload()
        for payload in (inside, outside, unplaced):
            await create(client, auth, payload)
        await place(client, auth, inside["id"], label="Chilonzor")
        await place(client, auth, outside["id"], latitude=LAT + 1.0)

        response = await client.get(
            "/api/v1/video-analyses/located", params={"bbox": BBOX_AROUND}, headers=auth
        )

        assert response.status_code == 200, response.text
        assert set(response.json()) == {"items"}
        [item] = response.json()["items"]
        assert set(item) == LOCATED_KEYS
        assert item["id"] == inside["id"]
        assert item["title"] == inside["title"]
        assert item["latitude"] == pytest.approx(LAT)
        assert item["longitude"] == pytest.approx(LON)
        assert item["accuracyM"] == 50.0
        assert item["label"] == "Chilonzor"
        assert item["potholeCount"] == 2
        assert item["posterUrl"] is None
        assert item["thumbnails"] == []

    async def test_thumbnails_are_uploaded_crops_worst_first_at_most_four(
        self, client: AsyncClient, auth
    ):
        scores = [0.1, 0.9, 0.5, 0.7, 0.3, 0.8]
        payload = analysis_payload(
            potholes=[
                pothole(
                    f"track-{i}",
                    severityScore=score,
                    firstSeenSeconds=float(i),
                    lastSeenSeconds=float(i) + 1,
                )
                for i, score in enumerate(scores)
            ]
        )
        created = (await create(client, auth, payload))["uploads"]["potholes"]
        await place(client, auth, payload["id"])
        # The best one never finished uploading, so it cannot be a thumbnail.
        uploaded = [f"track-{i}" for i in range(6) if i != 1]
        await complete(client, auth, payload["id"], crops=uploaded, poster=True)

        [item] = (
            await client.get(
                "/api/v1/video-analyses/located", params={"bbox": BBOX_AROUND}, headers=auth
            )
        ).json()["items"]

        assert len(item["thumbnails"]) == 4
        expected = ["track-5", "track-3", "track-2", "track-4"]  # 0.8, 0.7, 0.5, 0.3
        for url, track in zip(item["thumbnails"], expected, strict=True):
            assert created[track]["crop"]["key"] in url
        assert item["posterUrl"] is not None

    async def test_a_cleared_location_leaves_the_map(self, client: AsyncClient, auth):
        payload = analysis_payload()
        await create(client, auth, payload)
        await place(client, auth, payload["id"])
        await client.delete(f"/api/v1/video-analyses/{payload['id']}/location", headers=auth)

        response = await client.get(
            "/api/v1/video-analyses/located", params={"bbox": BBOX_AROUND}, headers=auth
        )
        assert response.json()["items"] == []

    @pytest.mark.parametrize(
        "bbox",
        ["not,a,bbox", "69.3,41.3,69.2,41.4", "0,0,10,10", "69.2,41.3,69.3"],
    )
    async def test_a_bad_bbox_is_refused(self, client: AsyncClient, auth, bbox: str):
        response = await client.get(
            "/api/v1/video-analyses/located", params={"bbox": bbox}, headers=auth
        )
        assert response.status_code == 422

    async def test_a_bbox_is_required(self, client: AsyncClient, auth):
        response = await client.get("/api/v1/video-analyses/located", headers=auth)
        assert response.status_code == 422


class TestVideoPotholeGallery:
    async def _two_analyses(self, client: AsyncClient, auth, db: AsyncSession):
        older = analysis_payload(
            title="Older",
            potholes=[
                pothole("b", firstSeenSeconds=8.0, lastSeenSeconds=9.0),
                pothole("a", firstSeenSeconds=2.0, lastSeenSeconds=3.0),
            ],
        )
        newer = analysis_payload(
            title="Newer",
            potholes=[
                pothole("z", firstSeenSeconds=20.0, lastSeenSeconds=21.0),
                pothole("x", firstSeenSeconds=1.0, lastSeenSeconds=2.0),
                pothole("y", firstSeenSeconds=5.0, lastSeenSeconds=6.0),
            ],
        )
        for payload, hours_ago in ((older, 2), (newer, 1)):
            await create(client, auth, payload)
            await db.execute(
                update(VideoAnalysis)
                .where(VideoAnalysis.id == uuid.UUID(payload["id"]))
                .values(created_at=datetime.now(UTC) - timedelta(hours=hours_ago))
            )
        await db.commit()
        await place(client, auth, newer["id"])
        return older, newer

    async def test_every_pothole_newest_analysis_first_then_clip_order(
        self, client: AsyncClient, auth, db: AsyncSession
    ):
        older, newer = await self._two_analyses(client, auth, db)

        response = await client.get("/api/v1/video-potholes", headers=auth)

        assert response.status_code == 200, response.text
        body = response.json()
        assert set(body) == {"items", "total"}
        assert body["total"] == 5
        assert [item["trackId"] for item in body["items"]] == ["x", "y", "z", "a", "b"]
        for item in body["items"]:
            assert set(item) == GALLERY_KEYS
        first, last = body["items"][0], body["items"][-1]
        assert first["analysisId"] == newer["id"]
        assert first["analysisTitle"] == "Newer"
        assert first["located"] is True
        assert last["analysisId"] == older["id"]
        assert last["located"] is False

    async def test_paging_keeps_the_total(self, client: AsyncClient, auth, db: AsyncSession):
        await self._two_analyses(client, auth, db)

        body = (
            await client.get(
                "/api/v1/video-potholes", params={"limit": 2, "offset": 1}, headers=auth
            )
        ).json()

        assert body["total"] == 5
        assert [item["trackId"] for item in body["items"]] == ["y", "z"]

    async def test_photo_urls_only_for_uploaded_images(
        self, client: AsyncClient, auth, db: AsyncSession
    ):
        older, _ = await self._two_analyses(client, auth, db)
        await complete(client, auth, older["id"], crops=["a"], fulls=["b"])

        items = (await client.get("/api/v1/video-potholes", headers=auth)).json()["items"]

        photos = {item["trackId"]: (item["cropUrl"], item["fullUrl"]) for item in items}
        assert photos["a"][0] is not None and photos["a"][1] is None
        assert photos["b"][0] is None and photos["b"][1] is not None
        assert photos["x"] == (None, None)

    @pytest.mark.parametrize(
        "params", [{"limit": 0}, {"limit": 201}, {"offset": -1}, {"limit": "many"}]
    )
    async def test_paging_bounds(self, client: AsyncClient, auth, params: dict):
        response = await client.get("/api/v1/video-potholes", params=params, headers=auth)
        assert response.status_code == 422

    async def test_the_default_page_is_60(self, client: AsyncClient, auth):
        many = [
            pothole(f"t-{i:03d}", firstSeenSeconds=float(i), lastSeenSeconds=float(i) + 1)
            for i in range(65)
        ]
        await create(client, auth, analysis_payload(potholes=many))

        body = (await client.get("/api/v1/video-potholes", headers=auth)).json()

        assert body["total"] == 65
        assert len(body["items"]) == 60

    async def test_an_empty_gallery(self, client: AsyncClient, auth):
        body = (await client.get("/api/v1/video-potholes", headers=auth)).json()
        assert body == {"items": [], "total": 0}
