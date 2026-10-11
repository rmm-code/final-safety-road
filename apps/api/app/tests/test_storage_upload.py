"""Signed uploads, exercised against real object storage.

A test that only inspects the signed URL proves nothing: every evidence image was once
rejected by storage while the API happily returned well-formed upload targets. These send
the bytes the way a phone does and read storage's answer. Skipped when MinIO is not
reachable, because a skipped test says so and a faked one would lie.
"""

from __future__ import annotations

import json
import uuid

import httpx
import pytest
from httpx import AsyncClient

from app.core.config import get_settings
from app.services.storage import ObjectStorage, StorageError
from app.tests.video_helpers import analysis_payload, pothole


def _storage() -> ObjectStorage:
    settings = get_settings()
    try:
        httpx.get(f"{settings.s3_endpoint_url}/minio/health/live", timeout=2)
    except httpx.HTTPError:
        pytest.skip(f"object storage is not reachable at {settings.s3_endpoint_url}")
    storage = ObjectStorage(settings)
    storage.ensure_bucket()
    return storage


def _post(form, body: bytes, content_type: str) -> httpx.Response:
    # The file must be the last part of the form; httpx sends `data` before `files`.
    return httpx.post(
        form.url,
        data=form.fields,
        files={"file": ("evidence", body, content_type)},
        timeout=10,
    )


@pytest.fixture
def storage():
    storage = _storage()
    keys: list[str] = []
    yield storage, keys
    client = storage._internal_client()
    for key in keys:
        client.delete_object(Bucket=get_settings().s3_bucket, Key=key)


def test_an_image_smaller_than_the_limit_uploads(storage):
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.jpg"
    keys.append(key)

    form = store.presign_upload(key, "image/jpeg")

    response = _post(form, b"\xff\xd8" + b"\0" * 2048, "image/jpeg")

    assert response.status_code == 204, response.text


def test_storage_refuses_a_body_over_the_limit(storage):
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.jpg"
    keys.append(key)
    oversize = b"\0" * (get_settings().max_image_bytes + 1)

    response = _post(store.presign_upload(key, "image/jpeg"), oversize, "image/jpeg")

    assert response.status_code == 400
    assert "EntityTooLarge" in response.text


def test_storage_refuses_a_content_type_that_was_not_signed(storage):
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.jpg"
    keys.append(key)
    form = store.presign_upload(key, "image/jpeg")
    form.fields["Content-Type"] = "video/mp4"

    response = _post(form, b"\0" * 2048, "video/mp4")

    assert response.status_code == 403


def test_a_non_image_type_is_never_signed():
    with pytest.raises(StorageError):
        ObjectStorage(get_settings()).presign_upload("selftest/x.mp4", "video/mp4")


# --- Saved video analyses -------------------------------------------------------------
#
# The same mechanism with per-kind policies: an overlay is JSON, a video is a video with a
# far larger cap, and neither may widen what the evidence-photo form accepts.


def test_an_overlay_json_uploads(storage):
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.json"
    keys.append(key)

    form = store.presign_upload(key, "application/json", kind="overlay")
    response = _post(form, b'{"frames": []}', "application/json")

    assert response.status_code == 204, response.text


def test_a_video_uploads(storage):
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.mp4"
    keys.append(key)

    form = store.presign_upload(key, "video/mp4", kind="video")
    response = _post(form, b"\0\0\0\x18ftypmp42" + b"\0" * 4096, "video/mp4")

    assert response.status_code == 204, response.text


def test_storage_enforces_the_video_cap(storage):
    # A tiny cap stands in for the real 95 MB, so the test proves storage enforces the
    # VIDEO kind's own limit without sending a hundred megabytes.
    _, keys = storage
    key = f"selftest/{uuid.uuid4()}.mp4"
    keys.append(key)
    store = ObjectStorage(get_settings().model_copy(update={"max_video_bytes": 4096}))

    form = store.presign_upload(key, "video/mp4", kind="video")
    response = _post(form, b"\0" * 4097, "video/mp4")

    assert response.status_code == 400
    assert "EntityTooLarge" in response.text


def test_storage_enforces_the_overlay_cap(storage):
    _, keys = storage
    key = f"selftest/{uuid.uuid4()}.json"
    keys.append(key)
    store = ObjectStorage(get_settings().model_copy(update={"max_overlay_bytes": 1024}))

    form = store.presign_upload(key, "application/json", kind="overlay")
    response = _post(form, b"[" + b"0," * 600 + b"0]", "application/json")

    assert response.status_code == 400
    assert "EntityTooLarge" in response.text


def test_the_video_cap_is_not_the_image_cap():
    # The evidence form keeps its own, much smaller, limit.
    settings = get_settings()
    store = ObjectStorage(settings)
    assert store.upload_policy("video").max_bytes == settings.max_video_bytes
    assert store.upload_policy("overlay").max_bytes == settings.max_overlay_bytes
    assert store.upload_policy("image").max_bytes == settings.max_image_bytes
    assert settings.max_video_bytes < 100_000_000  # Cloudflare's free-plan body limit


def test_storage_refuses_a_video_signed_as_another_video_type(storage):
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.mp4"
    keys.append(key)
    form = store.presign_upload(key, "video/mp4", kind="video")
    form.fields["Content-Type"] = "text/html"

    response = _post(form, b"<script>alert(1)</script>", "text/html")

    assert response.status_code == 403


@pytest.mark.parametrize(
    ("kind", "content_type"),
    [
        ("video", "image/jpeg"),
        ("video", "text/html"),
        ("overlay", "text/html"),
        ("overlay", "video/mp4"),
        ("image", "application/json"),
        ("spreadsheet", "image/jpeg"),
    ],
)
def test_a_kind_signs_only_its_own_types(kind: str, content_type: str):
    with pytest.raises(StorageError):
        ObjectStorage(get_settings()).presign_upload("selftest/x", content_type, kind=kind)


def test_a_cross_origin_ranged_read_of_a_video_is_allowed(storage):
    """What `<video crossorigin="anonymous">` needs on a cross-origin-isolated page.

    MinIO implements no bucket CORS (PutBucketCors answers NotImplemented); CORS is a
    server-wide setting, MINIO_API_CORS_ALLOW_ORIGIN, permissive by default. This pins the
    behaviour the replay page depends on, so tightening that setting without keeping the
    site's origin fails here rather than as a video that never plays.
    """
    store, keys = storage
    key = f"selftest/{uuid.uuid4()}.mp4"
    keys.append(key)
    body = bytes(range(256)) * 32
    form = store.presign_upload(key, "video/mp4", kind="video")
    assert _post(form, body, "video/mp4").status_code == 204
    url = store.presign_get(key)
    origin = get_settings().public_web_url

    response = httpx.get(url, headers={"Origin": origin, "Range": "bytes=100-199"}, timeout=10)

    assert response.status_code == 206
    assert response.content == body[100:200]
    assert response.headers["Content-Range"] == f"bytes 100-199/{len(body)}"
    assert response.headers["Access-Control-Allow-Origin"] in {"*", origin}
    exposed = {
        name.strip().lower()
        for name in response.headers["Access-Control-Expose-Headers"].split(",")
    }
    assert {"content-range", "accept-ranges", "content-length"} <= exposed

    # A Range header set by script (a fetch() of the overlay, say) is preflighted.
    preflight = httpx.options(
        url,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "range",
        },
        timeout=10,
    )
    assert preflight.status_code in {200, 204}
    assert preflight.headers["Access-Control-Allow-Origin"] in {"*", origin}
    assert "range" in preflight.headers["Access-Control-Allow-Headers"].lower()


def _post_target(target: dict, body: bytes, content_type: str) -> httpx.Response:
    """POST to an upload target exactly as the API returned it, the way the browser does."""
    return httpx.post(
        target["url"],
        data=target["fields"],
        files={"file": ("upload", body, content_type)},
        timeout=10,
    )


async def test_a_saved_analysis_uploads_through_its_targets_and_replays(
    client: AsyncClient, auth
):
    """The whole round trip: create, upload to storage, mark, read back what was stored."""
    _storage()
    payload = analysis_payload(potholes=[pothole("track-1", hasFull=False)])
    created = await client.post("/api/v1/video-analyses", json=payload, headers=auth)
    assert created.status_code == 201, created.text
    uploads = created.json()["uploads"]
    crop_target = uploads["potholes"]["track-1"]["crop"]
    keys = [uploads["overlay"]["key"], uploads["video"]["key"], crop_target["key"]]

    overlay = json.dumps({"frames": [{"t": 0.5, "boxes": [[0.1, 0.2, 0.3, 0.4, 0.81]]}]})
    video = b"\0\0\0\x18ftypmp42" + bytes(range(256)) * 64
    crop = b"\xff\xd8\xff\xe0" + b"\0" * 1024
    try:
        # A form signed for one type refuses another, enforced by storage itself.
        for target in (uploads["video"], uploads["overlay"]):
            tampered = {**target, "fields": {**target["fields"], "Content-Type": "text/html"}}
            refused = _post_target(tampered, b"<script>alert(1)</script>", "text/html")
            assert refused.status_code == 403, refused.text

        stored = _post_target(uploads["overlay"], overlay.encode(), "application/json")
        assert stored.status_code == 204
        assert _post_target(uploads["video"], video, "video/mp4").status_code == 204
        assert _post_target(crop_target, crop, "image/jpeg").status_code == 204

        done = await client.post(
            f"/api/v1/video-analyses/{payload['id']}/complete",
            json={"overlay": True, "video": True, "crops": ["track-1"]},
            headers=auth,
        )
        assert done.status_code == 200, done.text
        replay = done.json()

        assert httpx.get(replay["overlayUrl"], timeout=10).json() == json.loads(overlay)

        origin = get_settings().public_web_url
        ranged = httpx.get(
            replay["videoUrl"], headers={"Origin": origin, "Range": "bytes=0-15"}, timeout=10
        )
        assert ranged.status_code == 206
        assert ranged.content == video[:16]
        assert ranged.headers["Content-Type"] == "video/mp4"
        assert ranged.headers["Access-Control-Allow-Origin"] in {"*", origin}

        photo = httpx.get(replay["potholes"][0]["cropUrl"], timeout=10)
        assert photo.status_code == 200
        assert photo.content == crop
        assert photo.headers["Content-Type"] == "image/jpeg"

        # Offered, never uploaded, never marked: no link to a missing object.
        assert replay["posterUrl"] is None
    finally:
        internal = ObjectStorage(get_settings())._internal_client()
        for key in keys:
            internal.delete_object(Bucket=get_settings().s3_bucket, Key=key)
