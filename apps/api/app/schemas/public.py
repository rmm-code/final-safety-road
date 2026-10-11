"""What the public map is allowed to see.

Separate models from `PotholeOut`, not a subset of it, because the two have different
audiences and the difference must not be one forgotten field away. Nothing here carries a
reporter, an operator, a model version or an internal status name.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from app.schemas.common import SeverityLevel

# The three states the public map draws, and the only vocabulary it is given.
PublicState = Literal["unverified", "confirmed", "fixed"]

# Internal status -> public state. Statuses absent from this map are absent from the
# public map entirely: a defect an operator marked a false positive, ignored or archived
# is not something to publish, and defaulting them to a visible state would publish them.
PUBLIC_STATE_BY_STATUS: dict[str, PublicState] = {
    "reported": "unverified",
    "active": "confirmed",
    # Someone thinks it was fixed but nothing has confirmed it, so it stays on the map as
    # a problem. Claiming "fixed" on a guess is the one error a repair map cannot afford.
    "suspected_repaired": "confirmed",
    "repaired": "fixed",
}

VISIBLE_STATUSES = tuple(PUBLIC_STATE_BY_STATUS)


def public_state(status: str) -> PublicState | None:
    return PUBLIC_STATE_BY_STATUS.get(status)


class PublicPothole(BaseModel):
    id: uuid.UUID
    latitude: float
    longitude: float
    state: PublicState
    severity: SeverityLevel
    reported_count: int
    first_seen_at: datetime
    last_seen_at: datetime


class PublicPotholeDetail(PublicPothole):
    location_accuracy_m: float
    comment: str | None = None
    image_url: str | None = None


class PublicCounts(BaseModel):
    unverified: int
    confirmed: int
    fixed: int
    total: int


class PublicConfig(BaseModel):
    """What the public page needs to render itself, without a second round trip."""

    report_url: str
    bot_username: str
    confirmations_required: int
    telegram_enabled: bool
