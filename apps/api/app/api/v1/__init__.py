from fastapi import APIRouter

# `telegram` is deliberately absent from this import: its router is parked below, and an
# import with no use is an import the linter removes and the next person never restores.
from app.api.v1 import (
    auth,
    citizen_reports,
    detections,
    drive_sessions,
    potholes,
    public,
    stats,
    video_analyses,
)

api_router = APIRouter(prefix="/api/v1")
api_router.include_router(auth.router)
api_router.include_router(drive_sessions.router)
api_router.include_router(detections.router)
api_router.include_router(potholes.router)
api_router.include_router(stats.router)
api_router.include_router(citizen_reports.router)
api_router.include_router(video_analyses.router)
api_router.include_router(video_analyses.gallery_router)
# Unauthenticated. Kept last so it reads as the exception it is.
api_router.include_router(public.router)

# PARKED FOR THE NEXT STAGE - the Telegram bot.
#
# The code is complete and tested (`app/services/telegram/`, `app/api/v1/telegram.py`,
# `app/tests/test_telegram.py`, and `bot-poll` / `bot-webhook` in `app/cli.py`). Only the
# webhook route is switched off, because the hackathon demo has no bot registered with
# @BotFather and an endpoint nobody can reach is better absent than answering 503.
#
# To bring it back: uncomment the line below, set TELEGRAM_BOT_TOKEN and
# TELEGRAM_WEBHOOK_SECRET, and run `python -m app.cli bot-webhook --url https://...`.
# `/review`'s report queue and the public map do NOT depend on it; they stay live.
# api_router.include_router(telegram.router)

__all__ = ["api_router"]
