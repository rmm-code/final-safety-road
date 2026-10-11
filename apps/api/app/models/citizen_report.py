from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Numeric, String, Text
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_column, uuid_pk

CITIZEN_REPORT_STATES = ("pending", "accepted", "rejected")
CITIZEN_REPORT_SOURCES = ("telegram_bot", "telegram_miniapp")


class CitizenReport(Base):
    """One pothole reported by a member of the public.

    A SIGHTING, like `DetectionEvent`, and resolved against `potholes` by the same
    deduplication service - but a separate table, because the two have almost nothing in
    common. A detection carries a model version, a confidence and a drive session; a
    citizen report carries a person, a photo they chose and a pin they dropped. Forcing
    one into the other's shape would mean inventing a confidence for a human.

    The photo is held behind `review_state`: a public intake accepts images from
    strangers, so nothing a stranger uploads reaches a public surface until an operator
    has looked at it.
    """

    __tablename__ = "citizen_reports"

    id: Mapped[uuid.UUID] = uuid_pk()
    pothole_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("potholes.id", ondelete="SET NULL"), index=True
    )
    # Derived deterministically from the Telegram chat and message id, so a webhook
    # Telegram redelivers after a timeout lands on the unique constraint instead of
    # creating a second report. Same rule as `DetectionEvent.client_event_id`.
    client_report_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), unique=True, nullable=False, index=True
    )
    source: Mapped[str] = mapped_column(String(32), nullable=False)

    # Telegram's numeric user id. Kept because the bot has to be able to reply to the
    # person who reported, and because banning an abuser needs a stable handle. Never
    # leaves the API through a public route.
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger, index=True)
    telegram_username: Mapped[str | None] = mapped_column(String(64))
    telegram_chat_id: Mapped[int | None] = mapped_column(BigInteger)

    location: Mapped[object] = mapped_column(
        Geography(geometry_type="POINT", srid=4326), nullable=False
    )
    # A dropped pin has no reported accuracy, so this records how the point was obtained
    # rather than pretending to a GPS figure. Still stored, because dedup weights by it.
    location_accuracy_m: Mapped[float] = mapped_column(Numeric(8, 2), nullable=False)
    reported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    comment: Mapped[str | None] = mapped_column(Text)
    image_key: Mapped[str | None] = mapped_column(Text)

    review_state: Mapped[str] = mapped_column(
        String(16), nullable=False, default="pending", index=True
    )
    review_note: Mapped[str | None] = mapped_column(Text)
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at_column()

    __table_args__ = (
        Index("ix_citizen_reports_location", "location", postgresql_using="gist"),
        Index("ix_citizen_reports_state_created", "review_state", "created_at"),
    )
