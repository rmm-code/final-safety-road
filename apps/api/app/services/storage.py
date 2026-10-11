"""Object storage for evidence images and saved video analyses.

Images never pass through the API. The client asks for a pre-signed POST form and
uploads straight to storage, which keeps large bodies off the application server and out
of its memory. The API only ever records the resulting object key.

A POST form rather than a pre-signed PUT, because only a POST policy lets storage itself
enforce a size limit. A PUT can carry a size only by signing `Content-Length` - and then
every body that is not exactly that size fails the signature, which is how every evidence
image was being rejected.

Each form is signed for one upload KIND, and the kind fixes the content types and the size
cap storage enforces. The default is the evidence image, so a caller that names no kind
gets exactly the policy the evidence-photo endpoint has always had.

CORS: MinIO implements no bucket-level CORS (`PutBucketCors` answers NotImplemented). It
is one server-wide setting, `MINIO_API_CORS_ALLOW_ORIGIN`, which defaults to every origin
and already exposes `Content-Range` and `Accept-Ranges` - what a cross-origin `<video>` on
the cross-origin-isolated replay page needs to seek. Restrict it, if ever, to the site's
origins; `test_storage_upload.py` fails if a ranged cross-origin read stops working. MinIO
sends no `Cross-Origin-Resource-Policy`, so an isolated page must load storage media in
CORS mode (`crossorigin="anonymous"`), images included.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache

import boto3
from botocore.client import Config

from app.core.config import Settings

ALLOWED_CONTENT_TYPES = {"image/webp", "image/jpeg", "image/png"}

# The per-frame detection track a saved video analysis replays.
OVERLAY_CONTENT_TYPE = "application/json"
# Containers a browser can play back, and the extension each is stored under.
VIDEO_EXTENSIONS = {"video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov"}
# Posters, crops and full frames of a saved analysis are JPEG: the browser draws them on a
# canvas and encodes them itself, so there is no reason to accept anything else.
VIDEO_ANALYSIS_IMAGE_TYPE = "image/jpeg"

UPLOAD_KINDS = ("image", "overlay", "video")


class StorageError(RuntimeError):
    pass


@dataclass(frozen=True)
class PresignedUpload:
    """A form the browser POSTs as multipart: every field, then the file, last."""

    url: str
    fields: dict[str, str]


@dataclass(frozen=True, slots=True)
class UploadPolicy:
    """What storage will accept through one signed form: these types, at most this size."""

    content_types: frozenset[str]
    max_bytes: int


@lru_cache
def _client(endpoint: str, key: str, secret: str, region: str):
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=key,
        aws_secret_access_key=secret,
        region_name=region,
        config=Config(signature_version="s3v4"),
    )


class ObjectStorage:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    def _signing_client(self):
        # Signed for the endpoint a browser can actually reach, which inside Compose is
        # not the same host the API talks to.
        return _client(
            self._settings.public_s3_endpoint,
            self._settings.s3_access_key,
            self._settings.s3_secret_key,
            self._settings.s3_region,
        )

    def _internal_client(self):
        return _client(
            self._settings.s3_endpoint_url,
            self._settings.s3_access_key,
            self._settings.s3_secret_key,
            self._settings.s3_region,
        )

    def ensure_bucket(self) -> None:
        client = self._internal_client()
        try:
            client.head_bucket(Bucket=self._settings.s3_bucket)
        except Exception:
            client.create_bucket(Bucket=self._settings.s3_bucket)

    @staticmethod
    def build_key(
        *, event_id: uuid.UUID, kind: str, detected_at: datetime, content_type: str
    ) -> str:
        """Date-partitioned key, so a year of evidence stays navigable and prunable."""
        if kind not in {"full", "crop"}:
            raise StorageError(f"Unknown image kind: {kind}")
        if content_type not in ALLOWED_CONTENT_TYPES:
            raise StorageError(f"Unsupported image type: {content_type}")
        extension = {"image/webp": "webp", "image/jpeg": "jpg", "image/png": "png"}[content_type]
        return (
            f"events/{detected_at:%Y/%m/%d}/{event_id}/{kind}.{extension}"
        )

    @staticmethod
    def build_report_key(
        *, report_id: uuid.UUID, reported_at: datetime, content_type: str
    ) -> str:
        """Key for a photo sent by a member of the public.

        A separate prefix from `events/`, not a third `kind`: these images have a
        different provenance, a different retention question and a different audience,
        and a prefix is what makes "delete everything a banned account uploaded"
        expressible at all.
        """
        if content_type not in ALLOWED_CONTENT_TYPES:
            raise StorageError(f"Unsupported image type: {content_type}")
        extension = {"image/webp": "webp", "image/jpeg": "jpg", "image/png": "png"}[content_type]
        return f"reports/{reported_at:%Y/%m/%d}/{report_id}.{extension}"

    @staticmethod
    def build_video_analysis_key(
        *,
        analysis_id: uuid.UUID,
        kind: str,
        content_type: str,
        pothole_id: uuid.UUID | None = None,
    ) -> str:
        """Key for one object of a saved video analysis.

        Every object of an analysis lives under one prefix, so removing an analysis is one
        listing. Potholes are keyed by their server-side id, never by the client's track
        id: a client string never becomes part of a storage path.
        """
        prefix = f"video-analyses/{analysis_id}"
        if kind == "overlay" and content_type == OVERLAY_CONTENT_TYPE:
            return f"{prefix}/overlay.json"
        if kind == "video" and content_type in VIDEO_EXTENSIONS:
            return f"{prefix}/video.{VIDEO_EXTENSIONS[content_type]}"
        if kind == "poster" and content_type == VIDEO_ANALYSIS_IMAGE_TYPE:
            return f"{prefix}/poster.jpg"
        if kind in {"crop", "full"} and content_type == VIDEO_ANALYSIS_IMAGE_TYPE:
            if pothole_id is None:
                raise StorageError(f"A {kind} image belongs to a pothole")
            return f"{prefix}/potholes/{pothole_id}/{kind}.jpg"
        raise StorageError(f"No {kind} object of type {content_type} in a video analysis")

    def put_object(self, key: str, data: bytes, content_type: str) -> None:
        """Upload bytes the API is holding.

        The exception to "images never pass through the API": a photo sent to the bot
        only exists on Telegram's servers, and the phone that sent it cannot be asked to
        PUT it anywhere else.
        """
        if content_type not in ALLOWED_CONTENT_TYPES:
            raise StorageError(f"Unsupported image type: {content_type}")
        if len(data) > self._settings.max_image_bytes:
            raise StorageError(
                f"Image is {len(data)} bytes, over the {self._settings.max_image_bytes} limit"
            )
        self._internal_client().put_object(
            Bucket=self._settings.s3_bucket, Key=key, Body=data, ContentType=content_type
        )

    def upload_policy(self, kind: str) -> UploadPolicy:
        """The types and size cap one kind of signed upload is held to.

        `image` is the evidence photo - the only kind the detection and citizen-report
        endpoints ever ask for - and it keeps its own small cap. Raising a cap for videos
        must never raise it for a form meant for one evidence frame.
        """
        settings = self._settings
        if kind == "image":
            return UploadPolicy(frozenset(ALLOWED_CONTENT_TYPES), settings.max_image_bytes)
        if kind == "overlay":
            return UploadPolicy(frozenset({OVERLAY_CONTENT_TYPE}), settings.max_overlay_bytes)
        if kind == "video":
            return UploadPolicy(frozenset(VIDEO_EXTENSIONS), settings.max_video_bytes)
        raise StorageError(f"Unknown upload kind: {kind}")

    def presign_upload(self, key: str, content_type: str, kind: str = "image") -> PresignedUpload:
        """A signed POST form that storage enforces: this key, this type, this size.

        Storage rejects anything else outright - a different content type with 403, a body
        over the kind's cap with EntityTooLarge - so a client cannot use an endpoint meant
        for one evidence frame to upload a video.
        """
        policy = self.upload_policy(kind)
        if content_type not in policy.content_types:
            raise StorageError(f"Unsupported {kind} type: {content_type}")
        post = self._signing_client().generate_presigned_post(
            self._settings.s3_bucket,
            key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", 1, policy.max_bytes],
            ],
            ExpiresIn=self._settings.upload_url_ttl_seconds,
        )
        # Built here rather than taken from botocore. The policy signature covers the
        # bucket, key and conditions but not the URL, so storage published under a path
        # prefix by a reverse proxy still accepts the form - provided the URL is ours.
        url = f"{self._settings.public_s3_endpoint.rstrip('/')}/{self._settings.s3_bucket}"
        return PresignedUpload(url=url, fields=dict(post["fields"]))

    def presign_get(self, key: str, expires_in: int | None = None) -> str:
        return self._signing_client().generate_presigned_url(
            "get_object",
            Params={"Bucket": self._settings.s3_bucket, "Key": key},
            ExpiresIn=expires_in or self._settings.upload_url_ttl_seconds,
        )
