from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_column, uuid_pk


class TelegramReportDraft(Base):
    """A half-finished report from the bot conversation.

    Telegram cannot attach a location to a photo, so a report arrives as two messages and
    something has to hold the first one until the second lands. That state is in the
    database rather than in process memory for two reasons: the API may run more than one
    worker, and a deploy in the middle of someone's report should not silently lose the
    photo they just sent.

    One row per chat. A person reporting a second pothole overwrites their own draft,
    which is the behaviour they expect - the newest thing they sent is what they meant.
    """

    __tablename__ = "telegram_report_drafts"

    id: Mapped[uuid.UUID] = uuid_pk()
    chat_id: Mapped[int] = mapped_column(BigInteger, unique=True, nullable=False, index=True)
    telegram_user_id: Mapped[int | None] = mapped_column(BigInteger)
    telegram_username: Mapped[str | None] = mapped_column(String(64))

    photo_file_id: Mapped[str | None] = mapped_column(Text)
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    location_accuracy_m: Mapped[float | None] = mapped_column(Numeric(8, 2))
    comment: Mapped[str | None] = mapped_column(Text)
    # The message that completes the report supplies the idempotency key, so a draft has
    # to remember which message started it too - see `CitizenReport.client_report_id`.
    origin_message_id: Mapped[int | None] = mapped_column(BigInteger)

    created_at: Mapped[datetime] = created_at_column()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    @property
    def is_complete(self) -> bool:
        return self.photo_file_id is not None and self.latitude is not None
