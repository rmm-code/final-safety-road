"""Telegram integration: the reporting bot and the Mini App's identity check.

Split three ways on purpose. `client` is transport and knows nothing about potholes;
`handlers` is the conversation and knows nothing about HTTP; `initdata` is a signature
check that shares only the bot token with either. The webhook route and the polling
runner are both thin wrappers over `handlers`.
"""

from app.services.telegram.client import (
    TelegramClient,
    TelegramError,
    TelegramFile,
    largest_photo,
)
from app.services.telegram.handlers import HandledUpdate, TelegramBotService
from app.services.telegram.initdata import (
    InitDataError,
    TelegramWebAppUser,
    VerifiedInitData,
    sign_init_data,
    verify_init_data,
)

__all__ = [
    "HandledUpdate",
    "InitDataError",
    "TelegramBotService",
    "TelegramClient",
    "TelegramError",
    "TelegramFile",
    "TelegramWebAppUser",
    "VerifiedInitData",
    "largest_photo",
    "sign_init_data",
    "verify_init_data",
]
