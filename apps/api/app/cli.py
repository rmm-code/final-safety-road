"""Operational commands.

    python -m app.cli create-user --email you@example.com --name "You" --role admin
    python -m app.cli seed-demo
    python -m app.cli demo-images --dir ../../output/crops   # real photos on seeded rows
    python -m app.cli bot-poll                       # run the bot locally, no public URL
    python -m app.cli bot-webhook --url https://...  # point Telegram at a deployment

Kept as a module rather than a shell script so it shares the application's models,
settings and password hashing instead of reimplementing them.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.session import get_engine
from app.models import CitizenReport, DetectionEvent, DriveSession, Pothole, User
from app.models.user import USER_ROLES
from app.repositories.potholes import point


async def _session():
    settings = get_settings()
    return async_sessionmaker(get_engine(settings), expire_on_commit=False)()


async def create_user(email: str, name: str, role: str, password: str | None) -> None:
    if role not in USER_ROLES:
        raise SystemExit(f"role must be one of: {', '.join(USER_ROLES)}")

    secret = password or getpass.getpass("Password: ")
    async with await _session() as session:
        existing = (
            await session.execute(select(User).where(User.email == email.lower()))
        ).scalar_one_or_none()
        if existing is not None:
            raise SystemExit(f"A user with email {email} already exists.")

        session.add(
            User(
                email=email.lower(), name=name, role=role, password_hash=hash_password(secret)
            )
        )
        await session.commit()
    print(f"Created {role} {email}")


async def seed_demo() -> None:
    """A small, obviously-synthetic dataset for exercising the map and dashboard.

    Every row is marked as coming from a `seed-` model version so demo data can never be
    mistaken for real observations, and can be deleted by that marker.
    """
    settings = get_settings()
    async with await _session() as session:
        user = (
            await session.execute(select(User).where(User.email == "demo@example.com"))
        ).scalar_one_or_none()
        if user is None:
            user = User(
                email="demo@example.com",
                name="Demo Operator",
                role="operator",
                password_hash=hash_password("demo-password"),
            )
            session.add(user)
            await session.flush()

        drive = DriveSession(user_id=user.id, status="ended", ended_at=datetime.now(UTC))
        session.add(drive)
        await session.flush()

        base_lat, base_lng = 41.3112, 69.2797
        severities = ["small", "medium", "large"]
        now = datetime.now(UTC)

        for index in range(24):
            lat = base_lat + (index % 6) * 0.0016
            lng = base_lng + (index // 6) * 0.0021
            severity = severities[index % 3]
            detected_at = now - timedelta(hours=index * 2)

            pothole = Pothole(
                location=point(lat, lng),
                location_accuracy_m=6 + (index % 5),
                severity=severity,
                severity_score=0.2 + 0.3 * (index % 3),
                status="active",
                first_seen_at=detected_at,
                last_seen_at=detected_at,
                sighting_count=1 + index % 4,
            )
            session.add(pothole)
            await session.flush()

            session.add(
                DetectionEvent(
                    client_event_id=uuid.uuid4(),
                    drive_session_id=drive.id,
                    pothole_id=pothole.id,
                    location=point(lat, lng),
                    location_accuracy_m=6 + (index % 5),
                    detected_at=detected_at,
                    confidence=0.6 + 0.01 * (index % 30),
                    severity=severity,
                    severity_score=0.2 + 0.3 * (index % 3),
                    model_version="seed-demo-0.0.0",
                    event_metadata={"seeded": True},
                )
            )

        # A handful of the seeded defects are marked repaired, so the public map has
        # something green on it. Without them every marker is red and the "fixed" state
        # is untestable until a real repair happens.
        repaired = 0
        for index in range(24):
            if index % 7 != 0:
                continue
            lat = base_lat + (index % 6) * 0.0016
            lng = base_lng + (index // 6) * 0.0021
            found = (
                await session.execute(
                    select(Pothole).where(Pothole.first_seen_at == now - timedelta(hours=index * 2))
                )
            ).scalars().first()
            if found is not None:
                found.status = "repaired"
                repaired += 1

        # Reports from the public, so the unverified state has something purple in it.
        # Deliberately away from the detector's grid: an unverified pothole is one OUR
        # pipeline has not seen, and seeding one on top of a detection would immediately
        # be merged into it.
        citizen = 0
        for index in range(5):
            lat = base_lat - 0.004 - index * 0.0012
            lng = base_lng + 0.003 + index * 0.0009
            reported_at = now - timedelta(hours=index * 5)
            pothole = Pothole(
                location=point(lat, lng),
                location_accuracy_m=25,
                severity="unknown",
                severity_score=0,
                status="reported",
                first_seen_at=reported_at,
                last_seen_at=reported_at,
                sighting_count=1,
            )
            session.add(pothole)
            await session.flush()
            session.add(
                CitizenReport(
                    client_report_id=uuid.uuid4(),
                    source="telegram_bot",
                    pothole_id=pothole.id,
                    telegram_user_id=900_000 + index,
                    telegram_username=f"seed_user_{index}",
                    location=point(lat, lng),
                    location_accuracy_m=25,
                    reported_at=reported_at,
                    comment="Демонстрационное сообщение о яме",
                    review_state="pending",
                )
            )
            citizen += 1

        await session.commit()

    print(f"Seeded 24 demo potholes around {41.3112}, {69.2797}")
    print(f"  {repaired} marked repaired (green), {citizen} citizen reports (purple)")
    print("Sign in as demo@example.com / demo-password")
    print(f"Environment: {settings.environment}")


async def bot_poll() -> None:
    """Run the bot by long-polling, for development.

    Telegram delivers updates two ways: a webhook, which needs a public HTTPS URL, and
    long-polling, which needs nothing. Production uses the webhook; this exists so the
    conversation can be built and tested on a laptop without a tunnel.

    Both paths call the SAME `TelegramBotService.handle_update`. A bot that behaves
    differently in development than in production is a bot whose bugs only appear in
    production.
    """
    from app.services.telegram import TelegramBotService, TelegramClient

    settings = get_settings()
    if not settings.telegram_enabled:
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set.")

    client = TelegramClient(settings.telegram_bot_token, api_base=settings.telegram_api_base)
    me = await client.get_me()
    print(f"Polling as @{me.get('username')} (Ctrl-C to stop)")

    # A webhook and long-polling are mutually exclusive; Telegram refuses getUpdates while
    # one is registered.
    await client.delete_webhook()

    factory = async_sessionmaker(get_engine(settings), expire_on_commit=False)
    offset: int | None = None

    while True:
        try:
            updates = await client.get_updates(offset=offset)
        except Exception as error:  # network blip, Telegram hiccup
            print(f"getUpdates failed, retrying: {error}", file=sys.stderr)
            await asyncio.sleep(3)
            continue

        for update in updates:
            # Advance the offset before handling, so one poisonous update cannot be
            # fetched forever in a loop.
            offset = update["update_id"] + 1
            async with factory() as session:
                service = TelegramBotService(session, settings, client)
                try:
                    result = await service.handle_update(update)
                    await session.commit()
                    print(f"update {update['update_id']}: {result.action}")
                except Exception as error:
                    await session.rollback()
                    print(f"update {update['update_id']} failed: {error}", file=sys.stderr)


async def bot_webhook(url: str, drop_pending: bool) -> None:
    """Register (or clear) the webhook Telegram should deliver updates to."""
    from app.services.telegram import TelegramClient

    settings = get_settings()
    if not settings.telegram_enabled:
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set.")

    client = TelegramClient(settings.telegram_bot_token, api_base=settings.telegram_api_base)
    if not url:
        await client.delete_webhook(drop_pending=drop_pending)
        print("Webhook cleared. The bot will not receive updates until one is set.")
        return

    if not settings.telegram_webhook_secret:
        raise SystemExit(
            "TELEGRAM_WEBHOOK_SECRET is not set. Generate one with `openssl rand -hex 32`; "
            "the webhook endpoint is public and the secret is what authenticates Telegram."
        )
    if not url.startswith("https://"):
        raise SystemExit("Telegram only delivers webhooks over HTTPS.")

    await client.set_webhook(
        url, settings.telegram_webhook_secret, drop_pending=drop_pending
    )
    print(f"Webhook set to {url}")


DEMO_IMAGE_TYPES = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


async def demo_images(directory: str) -> None:
    """Give seeded potholes real photos, so clicking a demo marker shows a pothole.

    Seeded rows carry no images, which makes the public map's detail sheet an empty box on
    every marker. This uploads real pothole photographs - crops from a sample video - and
    attaches them to SEEDED rows only:

    - detection events whose model version starts with `seed-`, as their evidence crop;
    - citizen reports from the seed's `seed_user_*` accounts, as the photo they sent.
      Those stay `pending`, so accepting one in /review is what puts it on /live - the
      moderation step, demonstrated end to end.

    Real observations are never touched, and rows that already have an image are skipped,
    so running it twice changes nothing. Files are cycled in sorted order, so the same
    pothole gets the same photo on every machine.

    The photos are real; the locations they are attached to are not. Say so if you show it.
    """
    from app.services.storage import ObjectStorage

    settings = get_settings()
    folder = Path(directory).expanduser()
    files = sorted(
        path for path in folder.iterdir() if path.suffix.lower() in DEMO_IMAGE_TYPES
    ) if folder.is_dir() else []
    if not files:
        raise SystemExit(f"No .jpg/.jpeg/.png files in {folder}")

    storage = ObjectStorage(settings)
    storage.ensure_bucket()

    def payload(index: int) -> tuple[bytes, str]:
        path = files[index % len(files)]
        return path.read_bytes(), DEMO_IMAGE_TYPES[path.suffix.lower()]

    events_done = reports_done = 0
    async with await _session() as session:
        events = (
            await session.execute(
                select(DetectionEvent)
                .where(
                    DetectionEvent.model_version.like("seed-%"),
                    DetectionEvent.crop_image_key.is_(None),
                )
                .order_by(DetectionEvent.detected_at, DetectionEvent.id)
            )
        ).scalars().all()

        for index, event in enumerate(events):
            data, content_type = payload(index)
            key = storage.build_key(
                event_id=event.id,
                kind="crop",
                detected_at=event.detected_at,
                content_type=content_type,
            )
            storage.put_object(key, data, content_type)
            event.crop_image_key = key
            pothole = await session.get(Pothole, event.pothole_id) if event.pothole_id else None
            if pothole is not None and pothole.primary_image_key is None:
                pothole.primary_image_key = key
            events_done += 1

        reports = (
            await session.execute(
                select(CitizenReport)
                .where(
                    CitizenReport.telegram_username.like("seed_user_%"),
                    CitizenReport.image_key.is_(None),
                )
                .order_by(CitizenReport.reported_at, CitizenReport.id)
            )
        ).scalars().all()

        for index, report in enumerate(reports):
            data, content_type = payload(index + len(events))
            key = storage.build_report_key(
                report_id=report.id, reported_at=report.reported_at, content_type=content_type
            )
            storage.put_object(key, data, content_type)
            report.image_key = key
            reports_done += 1

        await session.commit()

    print(f"Attached {len(files)} photo(s) to {events_done} seeded detection event(s)")
    print(f"and {reports_done} seeded citizen report(s), which stay pending until accepted.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create-user", help="Create a user account")
    create.add_argument("--email", required=True)
    create.add_argument("--name", required=True)
    create.add_argument("--role", default="driver", choices=list(USER_ROLES))
    create.add_argument("--password", help="Prompted for when omitted")

    commands.add_parser("seed-demo", help="Insert obviously-synthetic demo data")

    images = commands.add_parser(
        "demo-images", help="Attach real pothole photos to SEEDED rows, for demos"
    )
    images.add_argument(
        "--dir", default="../../output/crops", help="Folder of .jpg/.png pothole photos"
    )

    commands.add_parser("bot-poll", help="Run the Telegram bot by long-polling (development)")

    webhook = commands.add_parser("bot-webhook", help="Point Telegram at a deployed webhook")
    webhook.add_argument(
        "--url", default="", help="https://host/api/v1/telegram/webhook; empty clears it"
    )
    webhook.add_argument("--drop-pending", action="store_true")

    args = parser.parse_args(argv)
    try:
        if args.command == "create-user":
            asyncio.run(create_user(args.email, args.name, args.role, args.password))
        elif args.command == "bot-poll":
            try:
                asyncio.run(bot_poll())
            except KeyboardInterrupt:
                print("\nStopped.")
        elif args.command == "bot-webhook":
            asyncio.run(bot_webhook(args.url, args.drop_pending))
        elif args.command == "demo-images":
            asyncio.run(demo_images(args.dir))
        else:
            asyncio.run(seed_demo())
    except SystemExit as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
