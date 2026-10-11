"""The Telegram webhook.

One public route, and the only thing standing in front of it is the secret token
Telegram echoes back in a header. That is deliberate and it is Telegram's own design: the
URL has to be reachable by their servers, so the URL cannot be the secret.

The handler answers 200 for anything it managed to process, including updates it chose to
ignore. A non-200 tells Telegram to redeliver, and redelivering an update we already
acted on is how one pothole becomes several - which is also why every report carries an
idempotency key derived from the message.
"""

from __future__ import annotations

import hmac
import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, status

from app.api.deps import DbDep, SettingsDep
from app.services.telegram import TelegramBotService, TelegramClient

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/telegram", tags=["telegram"])


@router.post("/webhook")
async def telegram_webhook(
    request: Request,
    db: DbDep,
    settings: SettingsDep,
    secret_token: str | None = Header(default=None, alias="X-Telegram-Bot-Api-Secret-Token"),
) -> dict[str, Any]:
    if not settings.telegram_enabled:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Telegram is not configured on this deployment",
        )
    if not settings.telegram_webhook_secret:
        # Refusing rather than accepting unauthenticated updates: a webhook with no
        # secret is an open endpoint that writes to the database.
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "TELEGRAM_WEBHOOK_SECRET must be set before the webhook will accept updates",
        )
    # Constant-time, for the same reason the initData check is.
    if not secret_token or not hmac.compare_digest(
        secret_token, settings.telegram_webhook_secret
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Bad webhook secret")

    try:
        update = await request.json()
    except ValueError as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Update is not JSON") from error
    if not isinstance(update, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Update is not an object")

    client = TelegramClient(settings.telegram_bot_token, api_base=settings.telegram_api_base)
    service = TelegramBotService(db, settings, client)

    try:
        result = await service.handle_update(update)
    except Exception:
        # Rolled back explicitly, because the session dependency commits on the way out
        # and a half-written report is worse than none.
        #
        # Then answered 200. Re-raising would return 500, and Telegram answers a 500 by
        # redelivering - so an update that fails for a reason that will not go away
        # becomes a retry loop. The cost is that a report lost to a transient failure is
        # lost silently; the person gets no confirmation message and resends. A durable
        # outbox would fix that properly, and is not worth its infrastructure yet.
        await db.rollback()
        logger.exception("Telegram update could not be handled: %s", update.get("update_id"))
        return {"ok": True, "action": "failed"}

    return {"ok": True, "action": result.action}
