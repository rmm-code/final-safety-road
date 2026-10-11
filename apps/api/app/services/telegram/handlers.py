"""The bot conversation.

One update in, zero or more Bot API calls out, and at most one report written. Kept as a
service rather than living in the route so the polling runner and the webhook run exactly
the same code - a bot that behaves differently in development than in production is a bot
whose bugs only appear in production.

The shape of the conversation is forced by Telegram: a photo and a location cannot arrive
in one message, so a report is always assembled from two. Either order is accepted,
because people send them in either order.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.models import TelegramReportDraft
from app.services.citizen_reports import (
    CitizenReportService,
    ReportInput,
    report_id_for_telegram,
)
from app.services.storage import ObjectStorage, StorageError
from app.services.telegram import text as t
from app.services.telegram.client import TelegramClient, TelegramError, largest_photo

logger = logging.getLogger(__name__)

# Telegram photos are always JPEG.
PHOTO_CONTENT_TYPE = "image/jpeg"

# A comment must not become an essay in a Text column nobody reads.
MAX_COMMENT_LENGTH = 500


@dataclass(slots=True)
class HandledUpdate:
    """What an update did, for logs and tests. Never sent to the user."""

    action: str
    chat_id: int | None = None
    report_id: str | None = None


class TelegramBotService:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        client: TelegramClient,
    ) -> None:
        self._session = session
        self._settings = settings
        self._client = client
        self._reports = CitizenReportService(session, settings)

    @property
    def _map_url(self) -> str:
        return f"{self._settings.public_web_url.rstrip('/')}/live"

    # -- Entry point -----------------------------------------------------------

    async def handle_update(self, update: dict[str, Any]) -> HandledUpdate:
        if "callback_query" in update:
            query = update["callback_query"]
            await self._client.answer_callback_query(query["id"])
            return HandledUpdate(action="callback_acknowledged")

        message = update.get("message")
        if not isinstance(message, dict):
            return HandledUpdate(action="ignored")

        chat = message.get("chat") or {}
        chat_id = chat.get("id")
        if chat_id is None:
            return HandledUpdate(action="ignored")

        if "photo" in message:
            return await self._on_photo(message, chat_id)
        if "location" in message:
            return await self._on_location(message, chat_id)

        raw_text = (message.get("text") or "").strip()
        if raw_text.startswith("/"):
            return await self._on_command(raw_text, chat_id)
        if raw_text:
            return await self._on_text(raw_text, message, chat_id)

        if "document" in message or "video" in message:
            await self._client.send_message(chat_id, t.NOT_A_PHOTO)
            return HandledUpdate(action="rejected_non_photo", chat_id=chat_id)

        return HandledUpdate(action="ignored", chat_id=chat_id)

    # -- Message kinds ---------------------------------------------------------

    async def _on_command(self, raw_text: str, chat_id: int) -> HandledUpdate:
        command = raw_text.split()[0].split("@")[0].lower()

        if command == "/start":
            # `/start report` is what the deep link from the web map sends, so the
            # person arrives already asking to report and should not be greeted twice.
            if "report" in raw_text.lower().split()[1:]:
                return await self._begin_report(chat_id)
            await self._client.send_message(
                chat_id,
                t.START.format(button=t.BUTTON_REPORT),
                reply_markup=t.main_keyboard(self._map_url),
            )
            return HandledUpdate(action="start", chat_id=chat_id)

        if command in {"/report", "/yama"}:
            return await self._begin_report(chat_id)

        if command == "/cancel":
            draft = await self._draft(chat_id)
            if draft is None:
                await self._client.send_message(chat_id, t.NOTHING_TO_CANCEL)
                return HandledUpdate(action="nothing_to_cancel", chat_id=chat_id)
            await self._session.delete(draft)
            await self._client.send_message(
                chat_id, t.CANCELLED, reply_markup=t.main_keyboard(self._map_url)
            )
            return HandledUpdate(action="cancelled", chat_id=chat_id)

        if command == "/map":
            await self._client.send_message(chat_id, t.MAP_LINK.format(url=self._map_url))
            return HandledUpdate(action="map", chat_id=chat_id)

        await self._client.send_message(
            chat_id,
            t.START.format(button=t.BUTTON_REPORT),
            reply_markup=t.main_keyboard(self._map_url),
        )
        return HandledUpdate(action="unknown_command", chat_id=chat_id)

    async def _on_text(
        self, raw_text: str, message: dict[str, Any], chat_id: int
    ) -> HandledUpdate:
        if raw_text == t.BUTTON_REPORT:
            return await self._begin_report(chat_id)
        if raw_text == t.BUTTON_CANCEL:
            return await self._on_command("/cancel", chat_id)
        if raw_text == t.BUTTON_MAP:
            await self._client.send_message(chat_id, t.MAP_LINK.format(url=self._map_url))
            return HandledUpdate(action="map", chat_id=chat_id)

        draft = await self._draft(chat_id)
        if draft is None:
            await self._client.send_message(
                chat_id,
                t.START.format(button=t.BUTTON_REPORT),
                reply_markup=t.main_keyboard(self._map_url),
            )
            return HandledUpdate(action="idle_text", chat_id=chat_id)

        # Free text during a report is what the person wants to say about the pothole.
        draft.comment = raw_text[:MAX_COMMENT_LENGTH]
        self._touch(draft, message)
        await self._session.flush()
        await self._prompt_for_missing(draft, chat_id)
        return HandledUpdate(action="comment_saved", chat_id=chat_id)

    async def _on_photo(self, message: dict[str, Any], chat_id: int) -> HandledUpdate:
        photo = largest_photo(message["photo"], max_bytes=self._settings.max_image_bytes)
        if photo is None:
            await self._client.send_message(chat_id, t.PHOTO_TOO_BIG)
            return HandledUpdate(action="photo_too_big", chat_id=chat_id)

        draft = await self._draft(chat_id) or await self._new_draft(chat_id, message)
        draft.photo_file_id = photo["file_id"]
        if caption := (message.get("caption") or "").strip():
            draft.comment = caption[:MAX_COMMENT_LENGTH]
        self._touch(draft, message)
        await self._session.flush()

        if draft.is_complete:
            return await self._complete(draft, chat_id)

        await self._client.send_message(
            chat_id,
            t.ASK_LOCATION.format(button=t.BUTTON_LOCATION),
            reply_markup=t.location_keyboard(),
        )
        return HandledUpdate(action="photo_saved", chat_id=chat_id)

    async def _on_location(self, message: dict[str, Any], chat_id: int) -> HandledUpdate:
        location = message["location"]
        draft = await self._draft(chat_id) or await self._new_draft(chat_id, message)
        draft.latitude = float(location["latitude"])
        draft.longitude = float(location["longitude"])
        accuracy = location.get("horizontal_accuracy")
        draft.location_accuracy_m = float(accuracy) if accuracy is not None else None
        self._touch(draft, message)
        await self._session.flush()

        if draft.is_complete:
            return await self._complete(draft, chat_id)

        await self._client.send_message(chat_id, t.ASK_PHOTO_AFTER_LOCATION)
        return HandledUpdate(action="location_saved", chat_id=chat_id)

    # -- Report completion -----------------------------------------------------

    async def _begin_report(self, chat_id: int) -> HandledUpdate:
        await self._client.send_message(chat_id, t.ASK_PHOTO)
        return HandledUpdate(action="ask_photo", chat_id=chat_id)

    async def _complete(self, draft: TelegramReportDraft, chat_id: int) -> HandledUpdate:
        assert draft.latitude is not None and draft.longitude is not None

        result = await self._reports.submit(
            ReportInput(
                # Derived from the message that finished the report, so a redelivered
                # update resolves to the same row instead of a second pothole.
                client_report_id=report_id_for_telegram(chat_id, draft.origin_message_id or 0),
                source="telegram_bot",
                latitude=float(draft.latitude),
                longitude=float(draft.longitude),
                reported_at=datetime.now(UTC),
                location_accuracy_m=(
                    float(draft.location_accuracy_m)
                    if draft.location_accuracy_m is not None
                    else None
                ),
                comment=draft.comment,
                telegram_user_id=draft.telegram_user_id,
                telegram_username=draft.telegram_username,
                telegram_chat_id=chat_id,
            )
        )

        photo_failed = False
        if not result.already_reported and draft.photo_file_id:
            photo_failed = not await self._store_photo(draft.photo_file_id, result)

        await self._session.delete(draft)
        await self._session.flush()

        if result.already_reported:
            await self._client.send_message(chat_id, t.SAVED_ALREADY)
        else:
            remaining = self._settings.citizen_confirmations_to_verify - result.distinct_reporters
            await self._client.send_message(
                chat_id,
                t.report_saved(
                    created=result.created_pothole,
                    verified=result.verified_now,
                    reporters=result.distinct_reporters,
                    remaining=remaining,
                    sightings=result.pothole.sighting_count,
                ),
                reply_markup=t.main_keyboard(self._map_url),
            )
            if photo_failed:
                await self._client.send_message(chat_id, t.PHOTO_FAILED)

        return HandledUpdate(
            action="report_created", chat_id=chat_id, report_id=str(result.report.id)
        )

    async def _store_photo(self, file_id: str, result) -> bool:
        """Move the photo from Telegram into our own storage. True when it landed.

        A failure here must not lose the report: the pothole is already recorded and a
        marker with no picture is far better than a dropped sighting. The person is told
        separately, so they know the photo did not arrive.
        """
        try:
            file = await self._client.get_file(file_id)
            data = await self._client.download(
                file.file_path, max_bytes=self._settings.max_image_bytes
            )
            storage = ObjectStorage(self._settings)
            key = storage.build_report_key(
                report_id=result.report.id,
                reported_at=result.report.reported_at,
                content_type=PHOTO_CONTENT_TYPE,
            )
            storage.put_object(key, data, PHOTO_CONTENT_TYPE)
            await self._reports.attach_image(result.report, key)
            return True
        except (TelegramError, StorageError) as error:
            logger.warning("Citizen report photo could not be stored: %s", error)
            return False
        except Exception:  # pragma: no cover - storage outage
            logger.exception("Unexpected failure storing a citizen report photo")
            return False

    # -- Drafts ----------------------------------------------------------------

    async def _draft(self, chat_id: int) -> TelegramReportDraft | None:
        return (
            await self._session.execute(
                select(TelegramReportDraft).where(TelegramReportDraft.chat_id == chat_id)
            )
        ).scalar_one_or_none()

    async def _new_draft(self, chat_id: int, message: dict[str, Any]) -> TelegramReportDraft:
        draft = TelegramReportDraft(chat_id=chat_id)
        self._session.add(draft)
        self._touch(draft, message)
        await self._session.flush()
        return draft

    @staticmethod
    def _touch(draft: TelegramReportDraft, message: dict[str, Any]) -> None:
        sender = message.get("from") or {}
        if sender.get("id") is not None:
            draft.telegram_user_id = sender["id"]
        if sender.get("username"):
            draft.telegram_username = str(sender["username"])[:64]
        # The LAST message of a report supplies the idempotency key, because that is the
        # one Telegram will redeliver if this handler fails to answer in time.
        if message.get("message_id") is not None:
            draft.origin_message_id = message["message_id"]

    async def _prompt_for_missing(self, draft: TelegramReportDraft, chat_id: int) -> None:
        if draft.photo_file_id is None:
            await self._client.send_message(chat_id, t.ASK_PHOTO)
        elif draft.latitude is None:
            await self._client.send_message(
                chat_id,
                t.ASK_LOCATION.format(button=t.BUTTON_LOCATION),
                reply_markup=t.location_keyboard(),
            )
