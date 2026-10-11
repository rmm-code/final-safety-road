"""The Telegram surface: who is allowed to talk to us, and what the bot does with it.

Two things are being defended here. The Mini App's `initData` is the only thing that ties
a request to a real Telegram account, and the webhook's secret header is the only thing
that separates Telegram from anyone who guessed the URL. Both are signature checks and
both are tested against tampering, not just against the happy path.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qsl, urlencode

import httpx
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import CitizenReport, Pothole, TelegramReportDraft
from app.services.telegram import (
    InitDataError,
    TelegramBotService,
    TelegramClient,
    largest_photo,
    sign_init_data,
    verify_init_data,
)

CHAT_ID = 555_000_111
USER_ID = 900_100
LAT, LON = 41.3305, 69.2712


def init_data(token: str, *, user_id: int = USER_ID, auth_date: int | None = None) -> str:
    return sign_init_data(
        {
            "auth_date": str(auth_date if auth_date is not None else int(time.time())),
            "query_id": "AAH-test",
            "user": json.dumps(
                {"id": user_id, "first_name": "Test", "username": "tester"},
                separators=(",", ":"),
            ),
        },
        token,
    )


# -- initData ------------------------------------------------------------------


def test_a_correctly_signed_payload_verifies(bot_token: str) -> None:
    verified = verify_init_data(init_data(bot_token), bot_token)

    assert verified.user.id == USER_ID
    assert verified.user.username == "tester"


def test_a_payload_signed_with_a_different_token_is_rejected(bot_token: str) -> None:
    """The signature is the only thing binding a request to a Telegram account."""
    forged = init_data("999999:SOME-OTHER-BOT-TOKEN")

    with pytest.raises(InitDataError):
        verify_init_data(forged, bot_token)


def test_tampering_with_the_user_invalidates_the_signature(bot_token: str) -> None:
    """Changing the user id is the attack: report as somebody else, or as many people.

    The signature is kept and only the payload edited, which is exactly what an attacker
    who captured a valid payload would do.
    """
    fields = dict(parse_qsl(init_data(bot_token, user_id=1), keep_blank_values=True))
    fields["user"] = json.dumps({"id": 2, "first_name": "Someone else"}, separators=(",", ":"))
    tampered = urlencode(fields)

    with pytest.raises(InitDataError):
        verify_init_data(tampered, bot_token)


def test_an_unsigned_payload_is_rejected(bot_token: str) -> None:
    with pytest.raises(InitDataError):
        verify_init_data("auth_date=1&user=%7B%22id%22%3A1%7D", bot_token)


def test_a_stale_payload_is_rejected(bot_token: str) -> None:
    old = init_data(bot_token, auth_date=int(time.time()) - 10_000)

    with pytest.raises(InitDataError):
        verify_init_data(old, bot_token, max_age_seconds=3_600)


def test_a_payload_from_the_future_is_rejected(bot_token: str) -> None:
    """Otherwise a captured payload replays forever by moving a clock forward."""
    ahead = init_data(bot_token, auth_date=int(time.time()) + 86_400)

    with pytest.raises(InitDataError):
        verify_init_data(ahead, bot_token)


def test_an_empty_token_verifies_nothing(bot_token: str) -> None:
    """A deployment with Telegram unconfigured must not accept every signature."""
    with pytest.raises(InitDataError):
        verify_init_data(init_data(bot_token), "")


# -- Webhook authentication ----------------------------------------------------
#
# The webhook ROUTE is parked for the hackathon - see the comment in
# `app/api/v1/__init__.py`. These assert 404 rather than 401 to pin that: the endpoint is
# unreachable, not unauthenticated. Flip them back to 401 when the include is restored.
#
# Everything below this block still exercises the live code: the conversation handler and
# the initData signature check are tested directly, not through HTTP.


def test_the_parked_webhook_module_still_imports() -> None:
    """Nothing imports the route at startup while it is parked, so a break in it would
    otherwise go unnoticed until the day it is switched back on."""
    import app.api.v1.telegram as webhook

    assert webhook.router.routes


async def test_the_parked_webhook_is_not_mounted(client: AsyncClient) -> None:
    response = await client.post(
        "/api/v1/telegram/webhook",
        json={"update_id": 1},
        headers={"X-Telegram-Bot-Api-Secret-Token": "not-the-secret"},
    )

    assert response.status_code == 404


async def test_the_parked_webhook_is_not_mounted_without_a_secret_either(
    client: AsyncClient,
) -> None:
    response = await client.post("/api/v1/telegram/webhook", json={"update_id": 1})

    assert response.status_code == 404


# -- The photo Telegram sends --------------------------------------------------


def test_the_largest_photo_that_fits_is_chosen() -> None:
    """Telegram sends one image several times over, smallest to largest."""
    sizes = [
        {"file_id": "small", "width": 90, "height": 160, "file_size": 1_000},
        {"file_id": "big", "width": 1280, "height": 2276, "file_size": 400_000},
        {"file_id": "huge", "width": 2560, "height": 4552, "file_size": 20_000_000},
    ]

    chosen = largest_photo(sizes, max_bytes=8_000_000)
    assert chosen is not None and chosen["file_id"] == "big"
    assert largest_photo(sizes, max_bytes=100) is None
    assert largest_photo([], max_bytes=8_000_000) is None


# -- The conversation ----------------------------------------------------------


class FakeTelegram:
    """A Bot API that records what the bot said instead of calling Telegram.

    A transport rather than a mocked service: the client's own request building, error
    handling and response parsing are then part of what these tests cover.
    """

    def __init__(self) -> None:
        self.sent: list[dict] = []

    def transport(self) -> httpx.MockTransport:
        def handle(request: httpx.Request) -> httpx.Response:
            method = request.url.path.rsplit("/", 1)[-1]
            body = json.loads(request.content) if request.content else {}
            self.sent.append({"method": method, **body})

            if method == "getFile":
                return httpx.Response(
                    200,
                    json={
                        "ok": True,
                        "result": {
                            "file_id": body["file_id"],
                            "file_path": "photos/file_1.jpg",
                            "file_size": 2048,
                        },
                    },
                )
            if request.url.path.startswith("/file/"):
                return httpx.Response(200, content=b"\xff\xd8\xff" + b"0" * 2045)
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 1}})

        return httpx.MockTransport(handle)

    @property
    def texts(self) -> list[str]:
        return [item["text"] for item in self.sent if item["method"] == "sendMessage"]


def photo_update(message_id: int = 10) -> dict:
    return {
        "update_id": message_id,
        "message": {
            "message_id": message_id,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": USER_ID, "username": "tester"},
            "photo": [
                {"file_id": "small", "width": 90, "height": 160, "file_size": 900},
                {"file_id": "large", "width": 1280, "height": 960, "file_size": 200_000},
            ],
        },
    }


def location_update(message_id: int = 11, lat: float = LAT, lon: float = LON) -> dict:
    return {
        "update_id": message_id,
        "message": {
            "message_id": message_id,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": USER_ID, "username": "tester"},
            "location": {"latitude": lat, "longitude": lon, "horizontal_accuracy": 12.0},
        },
    }


def text_update(text: str, message_id: int = 12) -> dict:
    return {
        "update_id": message_id,
        "message": {
            "message_id": message_id,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": USER_ID, "username": "tester"},
            "text": text,
        },
    }


def bot(db: AsyncSession, fake: FakeTelegram) -> TelegramBotService:
    settings = get_settings()
    client = TelegramClient(
        settings.telegram_bot_token,
        api_base=settings.telegram_api_base,
        transport=fake.transport(),
    )
    return TelegramBotService(db, settings, client)


async def test_a_photo_alone_is_held_and_the_location_is_asked_for(
    db: AsyncSession,
) -> None:
    """Telegram cannot attach a location to a photo, so a report is always two messages."""
    fake = FakeTelegram()
    result = await bot(db, fake).handle_update(photo_update())

    assert result.action == "photo_saved"
    assert (await db.execute(select(CitizenReport))).scalars().all() == []
    draft = (await db.execute(select(TelegramReportDraft))).scalar_one()
    assert draft.photo_file_id == "large", "the biggest size that fits"
    assert any("геолокацию" in text for text in fake.texts)


async def test_photo_then_location_creates_the_report(db: AsyncSession) -> None:
    fake = FakeTelegram()
    service = bot(db, fake)

    await service.handle_update(photo_update())
    result = await service.handle_update(location_update())

    assert result.action == "report_created"
    report = (await db.execute(select(CitizenReport))).scalar_one()
    assert report.telegram_user_id == USER_ID
    assert report.review_state == "pending", "nothing from the public is published unseen"

    pothole = (await db.execute(select(Pothole))).scalar_one()
    assert pothole.status == "reported"
    # The draft is gone, so the next photo starts a fresh report.
    assert (await db.execute(select(TelegramReportDraft))).scalars().all() == []


async def test_location_then_photo_works_too(db: AsyncSession) -> None:
    """People send them in either order, so both orders finish the report."""
    fake = FakeTelegram()
    service = bot(db, fake)

    await service.handle_update(location_update())
    result = await service.handle_update(photo_update())

    assert result.action == "report_created"
    assert (await db.execute(select(CitizenReport))).scalar_one() is not None


async def test_a_caption_becomes_the_comment(db: AsyncSession) -> None:
    fake = FakeTelegram()
    service = bot(db, fake)
    update = photo_update()
    update["message"]["caption"] = "Огромная яма у остановки"

    await service.handle_update(update)
    await service.handle_update(location_update())

    report = (await db.execute(select(CitizenReport))).scalar_one()
    assert report.comment == "Огромная яма у остановки"


async def test_cancel_discards_the_draft(db: AsyncSession) -> None:
    fake = FakeTelegram()
    service = bot(db, fake)

    await service.handle_update(photo_update())
    result = await service.handle_update(text_update("/cancel"))

    assert result.action == "cancelled"
    assert (await db.execute(select(TelegramReportDraft))).scalars().all() == []
    assert (await db.execute(select(CitizenReport))).scalars().all() == []


async def test_a_document_is_refused_rather_than_stored(db: AsyncSession) -> None:
    """A bot that accepts arbitrary files is a file host with a pothole theme."""
    fake = FakeTelegram()
    update = {
        "update_id": 30,
        "message": {
            "message_id": 30,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": USER_ID},
            "document": {"file_id": "doc", "file_name": "payload.zip"},
        },
    }

    result = await bot(db, fake).handle_update(update)

    assert result.action == "rejected_non_photo"
    assert (await db.execute(select(CitizenReport))).scalars().all() == []


async def test_start_greets_and_offers_the_report_button(db: AsyncSession) -> None:
    fake = FakeTelegram()

    await bot(db, fake).handle_update(text_update("/start"))

    sent = [item for item in fake.sent if item["method"] == "sendMessage"][0]
    assert "keyboard" in sent["reply_markup"]
    assert "Сообщить о яме" in json.dumps(sent["reply_markup"], ensure_ascii=False)


async def test_the_deep_link_from_the_web_map_goes_straight_to_reporting(
    db: AsyncSession,
) -> None:
    """`t.me/<bot>?start=report` is what the map's button opens."""
    fake = FakeTelegram()

    result = await bot(db, fake).handle_update(text_update("/start report"))

    assert result.action == "ask_photo"


async def test_an_unknown_update_is_ignored_quietly(db: AsyncSession) -> None:
    fake = FakeTelegram()

    result = await bot(db, fake).handle_update({"update_id": 1, "edited_message": {}})

    assert result.action == "ignored"
    assert fake.sent == []


async def test_the_client_surfaces_a_bot_api_error() -> None:
    """`{"ok": false}` arrives with HTTP 200, so a client that only checks the status
    code treats every failure as a success."""
    from app.services.telegram import TelegramError

    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"ok": False, "description": "chat not found", "error_code": 400}
        )
    )
    client = TelegramClient("123:abc", transport=transport)

    with pytest.raises(TelegramError) as error:
        await client.send_message(1, "hello")
    assert "chat not found" in str(error.value)


async def test_the_download_limit_is_enforced_against_the_bytes_not_the_claim() -> None:
    """`file_size` is the remote's word for how big a file is, so the limit is applied
    to what actually arrives."""
    from app.services.telegram import TelegramError

    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"0" * 5_000))
    client = TelegramClient("123:abc", transport=transport)

    with pytest.raises(TelegramError):
        await client.download("photos/x.jpg", max_bytes=1_000)


def test_verification_accepts_a_payload_signed_moments_ago(bot_token: str) -> None:
    now = datetime.now(UTC)
    raw = init_data(bot_token, auth_date=int((now - timedelta(seconds=30)).timestamp()))

    assert verify_init_data(raw, bot_token, now=now).user.id == USER_ID
