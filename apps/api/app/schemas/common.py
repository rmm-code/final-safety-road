from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

SeverityLevel = Literal["small", "medium", "large", "unknown"]
# "reported" is the unverified state: a member of the public says there is a pothole here
# and nothing has corroborated it yet. It is deliberately first - it is the weakest claim.
PotholeStatus = Literal[
    "reported",
    "active",
    "suspected_repaired",
    "repaired",
    "false_positive",
    "ignored",
    "archived",
]
CitizenReportState = Literal["pending", "accepted", "rejected"]
CitizenReportSource = Literal["telegram_bot", "telegram_miniapp"]
# Where a sighting's coordinates came from: the phone's own GPS fix, or a point an operator
# placed on the map for a video file, which carries no telemetry. Never conflated.
LocationSource = Literal["gps", "manual"]
UserRole = Literal["admin", "operator", "driver", "viewer"]


class UploadTarget(BaseModel):
    """A pre-signed POST form the client uses to send one image straight to storage.

    Sent as `multipart/form-data`: every entry of `fields`, then the file under `file`,
    which must come last. Storage enforces the content type and size the API signed.
    """

    key: str
    url: str
    fields: dict[str, str]
    method: Literal["POST"] = "POST"
    expires_in_seconds: int
