"""Password hashing and access tokens.

Deliberately small: bcrypt for passwords, a signed JWT for sessions. No refresh-token
rotation, no OAuth dance - the brief calls out over-engineered authentication as
something to avoid, and this is an internal tool behind a login.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
import jwt

from app.core.config import Settings


def hash_password(password: str) -> str:
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters.")
    # bcrypt silently truncates beyond 72 bytes; reject rather than quietly weaken.
    if len(password.encode("utf-8")) > 72:
        raise ValueError("Password must be at most 72 bytes.")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        # A malformed stored hash must read as "wrong password", never as an error that
        # tells an attacker something about the account.
        return False


def create_access_token(settings: Settings, *, user_id: uuid.UUID, role: str) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_access_token(settings: Settings, token: str) -> dict[str, Any]:
    """Decode and verify a token. Raises jwt.PyJWTError when it is not usable."""
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
