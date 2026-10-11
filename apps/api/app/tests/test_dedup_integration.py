"""Deduplication against real PostGIS.

The rule under test: many sightings, one physical pothole. These run against PostGIS
because `ST_DWithin` on a geography column is the mechanism - testing it against a fake
would prove nothing about production.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient

LAT, LON = 41.3112, 69.2797


def offset(metres: float) -> float:
    return metres / 111_320.0


def payload(session_id: str, **overrides) -> dict:
    body = {
        "clientEventId": str(uuid.uuid4()),
        "driveSessionId": session_id,
        "detectedAt": datetime.now(UTC).isoformat(),
        "confidence": 0.9,
        "severity": "medium",
        "severityScore": 0.5,
        "latitude": LAT,
        "longitude": LON,
        "locationAccuracyM": 8.0,
        "headingDeg": 90.0,
        "speedMps": 10.0,
        "modelVersion": "pothole-detector-0.1.0",
    }
    body.update(overrides)
    return body


async def post(client: AsyncClient, auth, session_id, **overrides) -> dict:
    response = await client.post(
        "/api/v1/detections", json=payload(session_id, **overrides), headers=auth
    )
    assert response.status_code == 201, response.text
    return response.json()


class TestMergingSightings:
    async def test_a_second_car_over_the_same_pothole_merges(
        self, client: AsyncClient, auth, drive_session_id
    ):
        first = await post(client, auth, drive_session_id)
        second = await post(client, auth, drive_session_id, latitude=LAT + offset(3))

        assert second["deduplicated"] is True
        assert second["created_pothole"] is False
        assert second["pothole_id"] == first["pothole_id"]

    async def test_a_hundred_passes_do_not_create_a_hundred_potholes(
        self, client: AsyncClient, auth, drive_session_id
    ):
        ids = set()
        for i in range(12):
            body = await post(client, auth, drive_session_id, latitude=LAT + offset(i % 4))
            ids.add(body["pothole_id"])
        # The central rule of the data model, stated as a test.
        assert len(ids) == 1

    async def test_a_defect_down_the_road_is_a_separate_pothole(
        self, client: AsyncClient, auth, drive_session_id
    ):
        first = await post(client, auth, drive_session_id)
        far = await post(client, auth, drive_session_id, latitude=LAT + offset(120))

        assert far["created_pothole"] is True
        assert far["pothole_id"] != first["pothole_id"]

    async def test_merging_increments_the_sighting_count(
        self, client: AsyncClient, auth, drive_session_id
    ):
        first = await post(client, auth, drive_session_id)
        await post(client, auth, drive_session_id, latitude=LAT + offset(2))
        await post(client, auth, drive_session_id, latitude=LAT + offset(4))

        detail = await client.get(f"/api/v1/potholes/{first['pothole_id']}", headers=auth)
        assert detail.json()["sighting_count"] == 3

    async def test_every_sighting_is_kept_as_history(
        self, client: AsyncClient, auth, drive_session_id
    ):
        first = await post(client, auth, drive_session_id)
        await post(client, auth, drive_session_id, latitude=LAT + offset(2))

        detail = await client.get(f"/api/v1/potholes/{first['pothole_id']}", headers=auth)
        # Merging must never destroy the record of who saw what and when.
        assert len(detail.json()["observations"]) == 2

    async def test_a_worse_look_escalates_the_severity(
        self, client: AsyncClient, auth, drive_session_id
    ):
        first = await post(client, auth, drive_session_id, severity="small", severityScore=0.2)
        await post(
            client, auth, drive_session_id, latitude=LAT + offset(2), severity="large", severityScore=0.9
        )

        detail = await client.get(f"/api/v1/potholes/{first['pothole_id']}", headers=auth)
        assert detail.json()["severity"] == "large"

    async def test_a_later_distant_glimpse_does_not_talk_it_down(
        self, client: AsyncClient, auth, drive_session_id
    ):
        first = await post(client, auth, drive_session_id, severity="large", severityScore=0.9)
        await post(
            client, auth, drive_session_id, latitude=LAT + offset(2), severity="small", severityScore=0.2
        )

        detail = await client.get(f"/api/v1/potholes/{first['pothole_id']}", headers=auth)
        assert detail.json()["severity"] == "large"

    async def test_same_pin_sightings_never_claim_better_than_their_fixes(
        self, client: AsyncClient, auth, drive_session_id
    ):
        # Six sightings of one pin, each good to 100 m. Measured before the fix: the map
        # showed 3.7 m, precision that no single fix ever had.
        first = await post(client, auth, drive_session_id, locationAccuracyM=100.0)
        for _ in range(5):
            merged = await post(client, auth, drive_session_id, locationAccuracyM=100.0)
            assert merged["pothole_id"] == first["pothole_id"]

        detail = (await client.get(f"/api/v1/potholes/{first['pothole_id']}", headers=auth)).json()
        assert detail["sighting_count"] == 6
        assert detail["location_accuracy_m"] == 100.0

    async def test_last_seen_advances_with_new_sightings(
        self, client: AsyncClient, auth, drive_session_id
    ):
        earlier = datetime.now(UTC) - timedelta(hours=3)
        first = await post(client, auth, drive_session_id, detectedAt=earlier.isoformat())
        later = datetime.now(UTC)
        await post(
            client, auth, drive_session_id, latitude=LAT + offset(2), detectedAt=later.isoformat()
        )

        detail = (await client.get(f"/api/v1/potholes/{first['pothole_id']}", headers=auth)).json()
        assert detail["last_seen_at"] > detail["first_seen_at"]


class TestSpatialQueries:
    async def test_bbox_returns_potholes_inside_the_viewport(
        self, client: AsyncClient, auth, drive_session_id
    ):
        await post(client, auth, drive_session_id)
        await post(client, auth, drive_session_id, latitude=LAT + offset(500))

        bbox = f"{LON - 0.01},{LAT - 0.01},{LON + 0.01},{LAT + 0.01}"
        response = await client.get(f"/api/v1/potholes?bbox={bbox}", headers=auth)
        assert response.status_code == 200
        assert len(response.json()) == 2

    async def test_bbox_excludes_potholes_outside_it(
        self, client: AsyncClient, auth, drive_session_id
    ):
        await post(client, auth, drive_session_id)
        far_bbox = "0,0,1,1"
        response = await client.get(f"/api/v1/potholes?bbox={far_bbox}", headers=auth)
        assert response.json() == []

    async def test_a_malformed_bbox_is_rejected(self, client: AsyncClient, auth):
        assert (await client.get("/api/v1/potholes?bbox=nonsense", headers=auth)).status_code == 422

    async def test_an_inverted_bbox_is_rejected(self, client: AsyncClient, auth):
        assert (await client.get("/api/v1/potholes?bbox=10,10,5,5", headers=auth)).status_code == 422

    async def test_a_whole_world_bbox_is_refused(self, client: AsyncClient, auth):
        # Without this, panning out would ask the database for every row it has.
        response = await client.get("/api/v1/potholes?bbox=-180,-90,180,90", headers=auth)
        assert response.status_code == 422

    async def test_severity_filter(self, client: AsyncClient, auth, drive_session_id):
        await post(client, auth, drive_session_id, severity="large", severityScore=0.9)
        await post(
            client, auth, drive_session_id, latitude=LAT + offset(300), severity="small", severityScore=0.1
        )

        bbox = f"{LON - 0.02},{LAT - 0.02},{LON + 0.02},{LAT + 0.02}"
        response = await client.get(f"/api/v1/potholes?bbox={bbox}&severity=large", headers=auth)
        assert [p["severity"] for p in response.json()] == ["large"]

    async def test_minimum_sightings_filter(self, client: AsyncClient, auth, drive_session_id):
        confirmed = await post(client, auth, drive_session_id)
        await post(client, auth, drive_session_id, latitude=LAT + offset(2))
        await post(client, auth, drive_session_id, latitude=LAT + offset(400))

        bbox = f"{LON - 0.02},{LAT - 0.02},{LON + 0.02},{LAT + 0.02}"
        response = await client.get(f"/api/v1/potholes?bbox={bbox}&min_sightings=2", headers=auth)
        assert [p["id"] for p in response.json()] == [confirmed["pothole_id"]]


class TestPotholeLifecycle:
    async def test_an_operator_can_mark_a_pothole_repaired(
        self, client: AsyncClient, auth, operator_auth, drive_session_id
    ):
        created = await post(client, auth, drive_session_id)
        response = await client.post(
            f"/api/v1/potholes/{created['pothole_id']}/status",
            json={"status": "repaired", "reason": "Resurfaced by the district team"},
            headers=operator_auth,
        )
        assert response.status_code == 200
        assert response.json()["status"] == "repaired"

    async def test_a_driver_may_not_change_status(
        self, client: AsyncClient, auth, drive_session_id
    ):
        created = await post(client, auth, drive_session_id)
        response = await client.post(
            f"/api/v1/potholes/{created['pothole_id']}/status",
            json={"status": "false_positive"},
            headers=auth,
        )
        assert response.status_code == 403

    async def test_a_repaired_pothole_leaves_the_active_map(
        self, client: AsyncClient, auth, operator_auth, drive_session_id
    ):
        created = await post(client, auth, drive_session_id)
        await client.post(
            f"/api/v1/potholes/{created['pothole_id']}/status",
            json={"status": "repaired"},
            headers=operator_auth,
        )
        bbox = f"{LON - 0.01},{LAT - 0.01},{LON + 0.01},{LAT + 0.01}"
        response = await client.get(f"/api/v1/potholes?bbox={bbox}&status=active", headers=auth)
        assert response.json() == []

    async def test_a_sighting_after_repair_reopens_the_pothole(
        self, client: AsyncClient, auth, operator_auth, drive_session_id
    ):
        created = await post(client, auth, drive_session_id)
        await client.post(
            f"/api/v1/potholes/{created['pothole_id']}/status",
            json={"status": "suspected_repaired"},
            headers=operator_auth,
        )
        await post(client, auth, drive_session_id, latitude=LAT + offset(2))

        detail = await client.get(f"/api/v1/potholes/{created['pothole_id']}", headers=auth)
        # Reported again means evidently not repaired.
        assert detail.json()["status"] == "active"


class TestStats:
    async def test_overview_counts_what_the_dashboard_shows(
        self, client: AsyncClient, auth, drive_session_id
    ):
        await post(client, auth, drive_session_id, severity="large", severityScore=0.9)
        await post(
            client, auth, drive_session_id, latitude=LAT + offset(300), severity="small", severityScore=0.1
        )

        response = await client.get("/api/v1/stats/overview", headers=auth)
        body = response.json()
        assert body["active_potholes"] == 2
        assert body["large"] == 1
        assert body["small"] == 1
        assert body["total_sightings"] == 2
        assert body["drive_sessions"] >= 1
