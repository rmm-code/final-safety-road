"""Verifying that a Mini App request really came from Telegram.

A Mini App is an ordinary web page, so anything it sends the API is attacker-controlled
until proven otherwise. What makes it trustworthy is `initData`: a query string Telegram
hands the page, signed with a key derived from the bot token. Checking that signature is
the ONLY thing that ties a request to a real Telegram account - the user id inside it is
worth nothing on its own.

Note the key derivation: the secret is HMAC(key="WebAppData", msg=bot_token), which is
not the same construction as the older Login Widget (sha256 of the token). Using the
wrong one fails every signature, and using them interchangeably would accept data signed
for a different purpose.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import parse_qsl, urlencode


class InitDataError(ValueError):
    """initData was missing, malformed, unsigned, badly signed or stale."""


@dataclass(frozen=True, slots=True)
class TelegramWebAppUser:
    id: int
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None
    language_code: str | None = None

    @property
    def display_name(self) -> str:
        parts = [part for part in (self.first_name, self.last_name) if part]
        return " ".join(parts) or (self.username or str(self.id))


@dataclass(frozen=True, slots=True)
class VerifiedInitData:
    user: TelegramWebAppUser
    auth_date: datetime
    query_id: str | None
    start_param: str | None


def _secret_key(bot_token: str) -> bytes:
    return hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()


def data_check_string(fields: dict[str, str]) -> str:
    """Telegram's canonical form: every field except `hash`, sorted, one `k=v` per line."""
    return "\n".join(f"{key}={fields[key]}" for key in sorted(fields) if key != "hash")


def verify_init_data(
    raw: str,
    bot_token: str,
    *,
    max_age_seconds: int = 86_400,
    now: datetime | None = None,
) -> VerifiedInitData:
    """Validate a raw initData string and return who sent it.

    Raises `InitDataError` for every failure mode, with no detail that would help an
    attacker distinguish "wrong signature" from "expired".
    """
    if not bot_token:
        raise InitDataError("Telegram is not configured")
    if not raw:
        raise InitDataError("initData is missing")

    # keep_blank_values, because a field present but empty is still part of the signed
    # payload and dropping it changes the check string.
    fields = dict(parse_qsl(raw, keep_blank_values=True, strict_parsing=False))
    provided = fields.get("hash")
    if not provided:
        raise InitDataError("initData is not signed")

    expected = hmac.new(
        _secret_key(bot_token), data_check_string(fields).encode(), hashlib.sha256
    ).hexdigest()
    # Constant-time: a timing-variable comparison of an HMAC is a forgery oracle.
    if not hmac.compare_digest(expected, provided):
        raise InitDataError("initData signature is invalid")

    raw_auth_date = fields.get("auth_date")
    if not raw_auth_date or not raw_auth_date.isdigit():
        raise InitDataError("initData has no usable auth_date")
    auth_date = datetime.fromtimestamp(int(raw_auth_date), tz=UTC)

    reference = now or datetime.now(UTC)
    age = (reference - auth_date).total_seconds()
    # A signature from the future is as wrong as one long expired, and allowing it would
    # let a captured payload be replayed indefinitely by moving a clock.
    if age < -300 or age > max_age_seconds:
        raise InitDataError("initData has expired")

    raw_user = fields.get("user")
    if not raw_user:
        raise InitDataError("initData carries no user")
    try:
        parsed = json.loads(raw_user)
    except ValueError as error:
        raise InitDataError("initData user is malformed") from error
    if not isinstance(parsed, dict) or "id" not in parsed:
        raise InitDataError("initData user is malformed")

    return VerifiedInitData(
        user=TelegramWebAppUser(
            id=int(parsed["id"]),
            first_name=parsed.get("first_name"),
            last_name=parsed.get("last_name"),
            username=parsed.get("username"),
            language_code=parsed.get("language_code"),
        ),
        auth_date=auth_date,
        query_id=fields.get("query_id"),
        start_param=fields.get("start_param"),
    )


def sign_init_data(fields: dict[str, str], bot_token: str) -> str:
    """Produce a correctly-signed initData string.

    Exists for tests: verification is only meaningful if something can generate a valid
    payload, and a test that hard-codes a hash captured from production would embed a
    real bot token in the repository.
    """
    signed = {key: value for key, value in fields.items() if key != "hash"}
    digest = hmac.new(
        _secret_key(bot_token), data_check_string(signed).encode(), hashlib.sha256
    ).hexdigest()
    return urlencode({**signed, "hash": digest})
