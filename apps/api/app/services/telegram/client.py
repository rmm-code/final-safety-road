"""A small typed client for the Telegram Bot API.

Hand-written rather than pulled from a bot framework. The frameworks bring a router, a
finite-state machine and an event loop of their own; this product needs two update types
and already has FastAPI's loop, so the dependency would cost more than it saves - and a
second loop inside an ASGI process is a class of bug worth not having.

Everything here is one HTTP shape: POST JSON to /bot<token>/<method>, read {"ok": true,
"result": ...}. Files are the one exception and are documented where they appear.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class TelegramError(RuntimeError):
    """The Bot API answered, and said no."""

    def __init__(self, method: str, description: str, error_code: int | None = None) -> None:
        super().__init__(f"{method} failed: {description}")
        self.method = method
        self.description = description
        self.error_code = error_code


@dataclass(frozen=True, slots=True)
class TelegramFile:
    file_id: str
    file_path: str
    file_size: int | None


class TelegramClient:
    """Talks to one bot.

    Not a singleton: the token is configuration, and tests construct one against a fake
    transport rather than monkey-patching a module-level instance.
    """

    def __init__(
        self,
        token: str,
        *,
        api_base: str = "https://api.telegram.org",
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 20.0,
    ) -> None:
        if not token:
            raise TelegramError("__init__", "A bot token is required")
        self._token = token
        self._api_base = api_base.rstrip("/")
        self._transport = transport
        self._timeout = timeout

    @property
    def _method_base(self) -> str:
        return f"{self._api_base}/bot{self._token}"

    def _client(self, timeout: float | None = None) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            transport=self._transport, timeout=timeout if timeout is not None else self._timeout
        )

    async def call(
        self, method: str, payload: dict[str, Any] | None = None, *, timeout: float | None = None
    ) -> Any:
        async with self._client(timeout) as client:
            response = await client.post(f"{self._method_base}/{method}", json=payload or {})
        try:
            body = response.json()
        except ValueError as error:  # pragma: no cover - Telegram always sends JSON
            raise TelegramError(method, f"Non-JSON response ({response.status_code})") from error

        if not body.get("ok"):
            raise TelegramError(
                method, str(body.get("description", "unknown error")), body.get("error_code")
            )
        return body.get("result")

    # -- Sending ---------------------------------------------------------------

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        reply_markup: dict[str, Any] | None = None,
        disable_web_page_preview: bool = True,
    ) -> Any:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": disable_web_page_preview},
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        return await self.call("sendMessage", payload)

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> Any:
        payload: dict[str, Any] = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text
        return await self.call("answerCallbackQuery", payload)

    # -- Files -----------------------------------------------------------------

    async def get_file(self, file_id: str) -> TelegramFile:
        result = await self.call("getFile", {"file_id": file_id})
        return TelegramFile(
            file_id=result["file_id"],
            file_path=result["file_path"],
            file_size=result.get("file_size"),
        )

    async def download(self, file_path: str, *, max_bytes: int) -> bytes:
        """Fetch a file the bot was sent.

        Streamed with a running byte count rather than read whole: `file_size` is
        Telegram's word for how big the file is, and a limit enforced only against a
        number the remote supplied is not a limit.
        """
        url = f"{self._api_base}/file/bot{self._token}/{file_path}"
        chunks: list[bytes] = []
        total = 0
        async with self._client() as client:
            async with client.stream("GET", url) as response:
                if response.status_code != 200:
                    raise TelegramError("download", f"HTTP {response.status_code} for {file_path}")
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise TelegramError(
                            "download", f"File exceeds the {max_bytes} byte limit"
                        )
                    chunks.append(chunk)
        return b"".join(chunks)

    # -- Updates ---------------------------------------------------------------

    async def get_updates(self, offset: int | None = None, timeout: int = 25) -> list[dict]:
        """Long-poll for updates. Used by the local development runner, not in production.

        The HTTP timeout must exceed the long-poll timeout, or the client gives up on a
        request the server is deliberately holding open.
        """
        payload: dict[str, Any] = {
            "timeout": timeout,
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            payload["offset"] = offset
        return await self.call("getUpdates", payload, timeout=timeout + 10)

    async def set_webhook(self, url: str, secret_token: str, *, drop_pending: bool = False) -> Any:
        return await self.call(
            "setWebhook",
            {
                "url": url,
                "secret_token": secret_token,
                "allowed_updates": ["message", "callback_query"],
                "drop_pending_updates": drop_pending,
            },
        )

    async def delete_webhook(self, *, drop_pending: bool = False) -> Any:
        return await self.call("deleteWebhook", {"drop_pending_updates": drop_pending})

    async def get_me(self) -> Any:
        return await self.call("getMe")


def largest_photo(photos: list[dict], *, max_bytes: int) -> dict | None:
    """Pick which of Telegram's photo sizes to keep.

    Telegram sends the same image several times over, smallest to largest. The largest is
    the one worth storing as evidence - but only if it fits, so this walks down from the
    biggest rather than blindly taking `photos[-1]` and failing on the size check
    afterwards. Sizes without a declared `file_size` are still considered: the download
    itself enforces the real limit.
    """
    if not photos:
        return None
    by_area = sorted(photos, key=lambda item: item.get("width", 0) * item.get("height", 0))
    for photo in reversed(by_area):
        size = photo.get("file_size")
        if size is None or size <= max_bytes:
            return photo
    return None
