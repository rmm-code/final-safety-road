"""API behaviour, exercised end to end against PostGIS."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

LAT, LON = 41.3112, 69.2797


def offset(metres: float) -> float:
    return metres / 111_320.0


def event_payload(session_id: str, **overrides) -> dict:
    payload = {
        "clientEventId": str(uuid.uuid4()),
        "driveSessionId": session_id,
        "detectedAt": datetime.now(UTC).isoformat(),
        "confidence": 0.92,
        "severity": "large",
        "severityScore": 0.82,
        "severityConfidence": 0.78,
        "latitude": LAT,
        "longitude": LON,
        "locationAccuracyM": 8.4,
        "headingDeg": 123.0,
        "speedMps": 8.9,
        "modelVersion": "pothole-detector-0.1.0",
    }
    payload.update(overrides)
    return payload


class TestAuth:
    async def test_login_returns_a_token(self, client: AsyncClient, driver):
        response = await client.post(
            "/api/v1/auth/login", json={"email": driver.email, "password": "correct-horse"}
        )
        assert response.status_code == 200
        assert response.json()["access_token"]

    async def test_wrong_password_is_rejected(self, client: AsyncClient, driver):
        response = await client.post(
            "/api/v1/auth/login", json={"email": driver.email, "password": "wrong-password"}
        )
        assert response.status_code == 401

    async def test_unknown_account_is_indistinguishable_from_a_wrong_password(
        self, client: AsyncClient, driver
    ):
        unknown = await client.post(
            "/api/v1/auth/login", json={"email": "nobody@example.com", "password": "correct-horse"}
        )
        wrong = await client.post(
            "/api/v1/auth/login", json={"email": driver.email, "password": "wrong-password"}
        )
        # Distinguishing them tells an attacker which addresses are worth attacking.
        assert unknown.status_code == wrong.status_code == 401
        assert unknown.json()["detail"] == wrong.json()["detail"]

    async def test_protected_routes_require_a_token(self, client: AsyncClient):
        assert (await client.get("/api/v1/auth/me")).status_code == 401

    async def test_a_forged_token_is_rejected(self, client: AsyncClient):
        response = await client.get(
            "/api/v1/auth/me", headers={"Authorization": "Bearer not.a.real.token"}
        )
        assert response.status_code == 401

    async def test_me_describes_the_caller(self, client: AsyncClient, auth, driver):
        response = await client.get("/api/v1/auth/me", headers=auth)
        assert response.json()["email"] == driver.email


class TestDriveSessions:
    async def test_creating_and_ending_a_session(self, client: AsyncClient, auth):
        created = await client.post(
            "/api/v1/drive-sessions", json={"device_name": "Pixel 8"}, headers=auth
        )
        assert created.status_code == 201
        session_id = created.json()["id"]

        ended = await client.post(f"/api/v1/drive-sessions/{session_id}/end", headers=auth)
        assert ended.status_code == 200
        assert ended.json()["status"] == "ended"
        assert ended.json()["ended_at"] is not None

    async def test_ending_twice_is_not_an_error(self, client: AsyncClient, auth, drive_session_id):
        # A phone that lost signal mid-request will retry.
        first = await client.post(f"/api/v1/drive-sessions/{drive_session_id}/end", headers=auth)
        second = await client.post(f"/api/v1/drive-sessions/{drive_session_id}/end", headers=auth)
        assert first.status_code == second.status_code == 200
        assert first.json()["ended_at"] == second.json()["ended_at"]

    async def test_another_users_session_is_not_visible(self, client: AsyncClient, drive_session_id, operator_auth):
        # An operator may look; a different driver may not. Operator is allowed here.
        response = await client.get(f"/api/v1/drive-sessions/{drive_session_id}", headers=operator_auth)
        assert response.status_code == 200

    async def test_a_phone_generated_id_is_kept(self, client: AsyncClient, auth):
        # A drive started out of signal already stamped its sightings with this id.
        session_id = str(uuid.uuid4())
        created = await client.post(
            "/api/v1/drive-sessions",
            json={"id": session_id, "started_at": "2026-10-10T08:00:00Z"},
            headers=auth,
        )
        assert created.status_code == 201
        assert created.json()["id"] == session_id
        assert created.json()["started_at"].startswith("2026-10-10T08:00:00")

    async def test_creating_the_same_id_twice_returns_the_session(self, client: AsyncClient, auth):
        # The phone retries a create whose answer it never received.
        session_id = str(uuid.uuid4())
        first = await client.post("/api/v1/drive-sessions", json={"id": session_id}, headers=auth)
        second = await client.post("/api/v1/drive-sessions", json={"id": session_id}, headers=auth)
        assert first.status_code == 201
        assert second.status_code == 200
        assert second.json()["id"] == session_id

    async def test_another_users_session_id_cannot_be_claimed(
        self, client: AsyncClient, drive_session_id, operator_auth
    ):
        response = await client.post(
            "/api/v1/drive-sessions", json={"id": drive_session_id}, headers=operator_auth
        )
        assert response.status_code == 409

    async def test_a_start_time_in_the_future_is_clamped(self, client: AsyncClient, auth):
        created = await client.post(
            "/api/v1/drive-sessions",
            json={"id": str(uuid.uuid4()), "started_at": "2099-01-01T00:00:00Z"},
            headers=auth,
        )
        assert created.status_code == 201
        assert not created.json()["started_at"].startswith("2099")

    async def test_a_late_end_keeps_the_time_the_drive_ended(self, client: AsyncClient, auth):
        session_id = str(uuid.uuid4())
        await client.post(
            "/api/v1/drive-sessions",
            json={"id": session_id, "started_at": "2026-10-10T08:00:00Z"},
            headers=auth,
        )
        ended = await client.post(
            f"/api/v1/drive-sessions/{session_id}/end",
            json={"ended_at": "2026-10-10T08:40:00Z"},
            headers=auth,
        )
        assert ended.status_code == 200
        assert ended.json()["ended_at"].startswith("2026-10-10T08:40:00")


class TestDetectionValidation:
    async def test_rejects_an_impossible_latitude(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections",
            json=event_payload(drive_session_id, latitude=91.0),
            headers=auth,
        )
        assert response.status_code == 422

    async def test_rejects_a_confidence_above_one(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections", json=event_payload(drive_session_id, confidence=1.4), headers=auth
        )
        assert response.status_code == 422

    async def test_rejects_negative_accuracy(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections",
            json=event_payload(drive_session_id, locationAccuracyM=-3),
            headers=auth,
        )
        assert response.status_code == 422

    async def test_rejects_an_unknown_severity(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections", json=event_payload(drive_session_id, severity="huge"), headers=auth
        )
        assert response.status_code == 422

    async def test_rejects_unknown_fields(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections",
            json={**event_payload(drive_session_id), "depthCm": 12},
            headers=auth,
        )
        # This system does not accept physical measurements it cannot make.
        assert response.status_code == 422

    async def test_rejects_a_synthetic_sighting(self, client: AsyncClient, auth, drive_session_id):
        # The mock engine fabricates boxes. One accepted here would sit on the map at a real
        # GPS position and promote a citizen's "reported" pothole to "active" on nothing.
        response = await client.post(
            "/api/v1/detections",
            json=event_payload(drive_session_id, modelVersion="mock-synthetic-0.1.0"),
            headers=auth,
        )
        assert response.status_code == 422
        listed = await client.get("/api/v1/potholes", params={"bbox": BBOX}, headers=auth)
        assert listed.json() == []

    async def test_rejects_a_session_that_does_not_exist(self, client: AsyncClient, auth):
        response = await client.post(
            "/api/v1/detections", json=event_payload(str(uuid.uuid4())), headers=auth
        )
        assert response.status_code == 404

    async def test_rejects_an_unsupported_image_type(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections?image_content_type=video/mp4",
            json=event_payload(drive_session_id),
            headers=auth,
        )
        assert response.status_code == 415


class TestIngestion:
    async def test_first_sighting_creates_a_pothole(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections", json=event_payload(drive_session_id), headers=auth
        )
        assert response.status_code == 201
        body = response.json()
        assert body["created_pothole"] is True
        assert body["deduplicated"] is False
        assert body["pothole_id"]

    async def test_retrying_the_same_event_does_not_create_a_second_pothole(
        self, client: AsyncClient, auth, drive_session_id
    ):
        payload = event_payload(drive_session_id)
        first = await client.post("/api/v1/detections", json=payload, headers=auth)
        second = await client.post("/api/v1/detections", json=payload, headers=auth)

        assert second.status_code == 201
        assert second.json()["already_ingested"] is True
        # The whole point of clientEventId: a lost connection must not duplicate a defect.
        assert first.json()["pothole_id"] == second.json()["pothole_id"]
        assert first.json()["event"]["id"] == second.json()["event"]["id"]

    async def test_an_event_returns_a_signed_upload_target(self, client: AsyncClient, auth, drive_session_id):
        response = await client.post(
            "/api/v1/detections", json=event_payload(drive_session_id), headers=auth
        )
        upload = response.json()["crop_image_upload"]
        # Images go straight to storage; large bodies never pass through the API.
        assert upload is not None
        assert upload["url"].startswith("http")
        assert upload["method"] == "POST"
        assert upload["fields"]["key"] == upload["key"]
        assert upload["fields"]["Content-Type"] == "image/webp"
        assert upload["key"].endswith("crop.webp")


BBOX = f"{LON - 0.01},{LAT - 0.01},{LON + 0.01},{LAT + 0.01}"


async def _pothole(client: AsyncClient, auth, drive_session_id: str, **overrides) -> str:
    response = await client.post(
        "/api/v1/detections", json=event_payload(drive_session_id, **overrides), headers=auth
    )
    assert response.status_code == 201, response.text
    return response.json()["pothole_id"]


class TestReview:
    async def test_confirming_a_pothole_keeps_it_active_and_records_the_verdict(
        self, client: AsyncClient, auth, drive_session_id, operator_auth
    ):
        pothole_id = await _pothole(client, auth, drive_session_id)

        response = await client.post(
            f"/api/v1/potholes/{pothole_id}/review",
            json={"verdict": "correct"},
            headers=operator_auth,
        )

        assert response.status_code == 200, response.text
        body = response.json()
        # A real pothole stays on the map; the review is a verdict, not a status change.
        assert body["status"] == "active"
        assert body["review_verdict"] == "correct"
        assert body["reviewed_at"] is not None

    async def test_a_false_positive_leaves_the_map_with_a_history_row(
        self, client: AsyncClient, auth, drive_session_id, operator_auth, db
    ):
        from sqlalchemy import select

        from app.models import PotholeStatusHistory

        pothole_id = await _pothole(client, auth, drive_session_id)

        response = await client.post(
            f"/api/v1/potholes/{pothole_id}/review",
            json={"verdict": "false_positive", "note": "Manhole cover"},
            headers=operator_auth,
        )

        assert response.json()["status"] == "false_positive"
        rows = (
            await db.execute(
                select(PotholeStatusHistory).where(
                    PotholeStatusHistory.pothole_id == uuid.UUID(pothole_id)
                )
            )
        ).scalars().all()
        assert [(row.new_status, row.reason) for row in rows] == [
            ("false_positive", "Manhole cover")
        ]

    async def test_a_reviewed_pothole_leaves_the_review_queue(
        self, client: AsyncClient, auth, drive_session_id, operator_auth
    ):
        pothole_id = await _pothole(client, auth, drive_session_id)
        await client.post(
            f"/api/v1/potholes/{pothole_id}/review", json={"verdict": "correct"}, headers=operator_auth
        )

        queue = await client.get(
            "/api/v1/potholes", params={"bbox": BBOX, "reviewed": "false"}, headers=operator_auth
        )

        assert pothole_id not in [row["id"] for row in queue.json()]

    async def test_a_driver_cannot_review(self, client: AsyncClient, auth, drive_session_id):
        pothole_id = await _pothole(client, auth, drive_session_id)
        response = await client.post(
            f"/api/v1/potholes/{pothole_id}/review", json={"verdict": "correct"}, headers=auth
        )
        assert response.status_code == 403


class TestPotholeQueries:
    async def test_the_list_can_put_the_worst_first(
        self, client: AsyncClient, auth, drive_session_id
    ):
        # Far enough apart that dedup keeps them as two potholes.
        mild = await _pothole(
            client, auth, drive_session_id, severity="small", severityScore=0.2
        )
        worst = await _pothole(
            client,
            auth,
            drive_session_id,
            severity="large",
            severityScore=0.95,
            latitude=LAT + 0.002,
        )

        rows = await client.get(
            "/api/v1/potholes", params={"bbox": BBOX, "order": "severity"}, headers=auth
        )
        ids = [row["id"] for row in rows.json()]

        assert ids.index(worst) < ids.index(mild)

    async def test_the_detail_carries_signed_links_to_its_evidence(
        self, client: AsyncClient, auth, drive_session_id
    ):
        pothole_id = await _pothole(client, auth, drive_session_id)

        detail = (await client.get(f"/api/v1/potholes/{pothole_id}", headers=auth)).json()

        observation = detail["observations"][0]
        assert observation["crop_image_key"]
        assert observation["crop_image_url"].startswith("http")
        assert "X-Amz-Signature" in observation["crop_image_url"]


class TestLocationSource:
    """A video file carries no GPS, so an operator may place a clip on the map by hand.

    Coordinates are never fabricated, and a hand-placed point is only honest while it says
    so: the source is stored with the sighting and comes back wherever the sighting does.
    """

    async def test_a_hand_placed_sighting_is_stored_and_returned_as_manual(
        self, client: AsyncClient, auth, drive_session_id, db
    ):
        from sqlalchemy import select

        from app.models import DetectionEvent

        response = await client.post(
            "/api/v1/detections",
            json=event_payload(drive_session_id, locationSource="manual", locationAccuracyM=100),
            headers=auth,
        )

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["event"]["location_source"] == "manual"
        event_id = body["event"]["id"]
        stored = (
            await db.execute(
                select(DetectionEvent.location_source).where(
                    DetectionEvent.id == uuid.UUID(event_id)
                )
            )
        ).scalar_one()
        assert stored == "manual"
        event = (await client.get(f"/api/v1/detections/{event_id}", headers=auth)).json()
        assert event["location_source"] == "manual"
        detail = (await client.get(f"/api/v1/potholes/{body['pothole_id']}", headers=auth)).json()
        assert [row["location_source"] for row in detail["observations"]] == ["manual"]

    async def test_a_sighting_without_a_source_comes_back_as_gps(
        self, client: AsyncClient, auth, drive_session_id
    ):
        payload = event_payload(drive_session_id)
        # Every phone in the field uploads without the field; absent has to mean GPS.
        assert "locationSource" not in payload

        response = await client.post("/api/v1/detections", json=payload, headers=auth)

        assert response.status_code == 201, response.text
        body = response.json()
        assert body["event"]["location_source"] == "gps"
        detail = (await client.get(f"/api/v1/potholes/{body['pothole_id']}", headers=auth)).json()
        observation = detail["observations"][0]
        assert observation["location_source"] == "gps"
        # The console shows a GPS sighting's own accuracy where a manual one says so.
        assert observation["location_accuracy_m"] == 8.4

    async def test_rejects_an_unknown_location_source(
        self, client: AsyncClient, auth, drive_session_id
    ):
        response = await client.post(
            "/api/v1/detections",
            json=event_payload(drive_session_id, locationSource="estimated"),
            headers=auth,
        )
        assert response.status_code == 422
