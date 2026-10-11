"""Runtime configuration, read once from the environment.

Secrets never have a usable default: a deployment that forgets to set one should fail
loudly at startup rather than run with a value an attacker can look up in this file.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="", extra="ignore")

    environment: str = Field(default="development", alias="ENVIRONMENT")

    database_url: str = Field(
        default="postgresql+asyncpg://pothole:pothole@localhost:5433/pothole",
        alias="DATABASE_URL",
    )

    # --- Hackathon demo ------------------------------------------------------
    # Serve the internal console without anyone signing in.
    #
    # The console has no login screen, so every authenticated call answers 401 and the
    # map, the dashboard and the review queue all render as errors. For a demo that is
    # the whole product looking broken.
    #
    # Nothing is removed: tokens still work when presented, every route still resolves a
    # real `User`, and `require_roles` still runs. The flag only decides what happens
    # when NO credentials arrive. It defaults to off and the validator below refuses it
    # in production, so this cannot reach a real deployment by being forgotten.
    auth_disabled: bool = Field(default=False, alias="AUTH_DISABLED")
    # The account unauthenticated requests act as while the flag is on. It has to be a
    # real row: drive sessions, status history and report reviews all record who did it.
    demo_user_email: str = Field(default="demo@example.com", alias="DEMO_USER_EMAIL")

    jwt_secret: str = Field(default="", alias="JWT_SECRET")
    jwt_algorithm: str = Field(default="HS256", alias="JWT_ALGORITHM")
    access_token_ttl_minutes: int = Field(default=720, alias="ACCESS_TOKEN_TTL_MINUTES")

    s3_endpoint_url: str = Field(default="http://localhost:9000", alias="S3_ENDPOINT_URL")
    s3_public_endpoint_url: str = Field(default="", alias="S3_PUBLIC_ENDPOINT_URL")
    s3_access_key: str = Field(default="minioadmin", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="minioadmin", alias="S3_SECRET_KEY")
    s3_bucket: str = Field(default="pothole-evidence", alias="S3_BUCKET")
    s3_region: str = Field(default="us-east-1", alias="S3_REGION")
    upload_url_ttl_seconds: int = Field(default=900, alias="UPLOAD_URL_TTL_SECONDS")

    # Browser origins allowed to call the API. Never "*" - the API is credentialed.
    cors_origins: str = Field(
        default="http://localhost:3000,http://localhost:3001", alias="CORS_ORIGINS"
    )

    # Deduplication. A phone fix is good to roughly 5-15 m, so sightings inside this
    # radius are candidates for the same physical defect.
    dedup_radius_m: float = Field(default=10.0, alias="DEDUP_RADIUS_M")
    dedup_max_radius_m: float = Field(default=35.0, alias="DEDUP_MAX_RADIUS_M")
    dedup_merge_threshold: float = Field(default=0.55, alias="DEDUP_MERGE_THRESHOLD")

    max_image_bytes: int = Field(default=8 * 1024 * 1024, alias="MAX_IMAGE_BYTES")
    # Saved video analyses. The overlay is the per-frame detection track the browser
    # replays over the video. The video cap sits under Cloudflare's free-plan limit of
    # 100 MB per request body, multipart overhead included: a larger upload would be
    # refused at the edge with an error that never reaches the app.
    max_overlay_bytes: int = Field(default=20 * 1024 * 1024, alias="MAX_OVERLAY_BYTES")
    max_video_bytes: int = Field(default=95 * 1024 * 1024, alias="MAX_VIDEO_BYTES")
    # Lifetime of read links for saved videos and their images. Longer than the upload
    # TTL because a <video> keeps requesting byte ranges with the same link for as long as
    # someone watches: at 15 minutes, a paused replay broke on its next seek.
    media_url_ttl_seconds: int = Field(default=6 * 60 * 60, alias="MEDIA_URL_TTL_SECONDS")
    rate_limit_per_minute: int = Field(default=240, alias="RATE_LIMIT_PER_MINUTE")
    # A public intake is reachable by anyone, so it gets a much tighter cap than the
    # authenticated API a fleet of phones hammers legitimately.
    public_rate_limit_per_minute: int = Field(default=60, alias="PUBLIC_RATE_LIMIT_PER_MINUTE")

    # Telegram. Deliberately optional and defaulted to empty, unlike JWT_SECRET: the API
    # ran before the bot existed and must keep running without it. Every Telegram route
    # reports 503 while unconfigured rather than the process refusing to boot.
    telegram_bot_token: str = Field(default="", alias="TELEGRAM_BOT_TOKEN")
    telegram_bot_username: str = Field(default="", alias="TELEGRAM_BOT_USERNAME")
    # Telegram echoes this back in X-Telegram-Bot-Api-Secret-Token. It is what proves an
    # inbound webhook is really Telegram, since the endpoint itself must be public.
    telegram_webhook_secret: str = Field(default="", alias="TELEGRAM_WEBHOOK_SECRET")
    telegram_api_base: str = Field(default="https://api.telegram.org", alias="TELEGRAM_API_BASE")
    # How stale a Mini App initData signature may be. Telegram's own guidance is to
    # reject old ones; a day is generous for a session someone leaves open.
    telegram_init_data_max_age_seconds: int = Field(
        default=86_400, alias="TELEGRAM_INIT_DATA_MAX_AGE_SECONDS"
    )

    # Where the public map lives, used for the link the bot sends back after a report.
    public_web_url: str = Field(default="http://localhost:3000", alias="PUBLIC_WEB_URL")

    # Independent reporters needed before an unverified pothole is treated as real.
    # Counted per person, not per report: one enthusiast cannot verify their own sighting.
    citizen_confirmations_to_verify: int = Field(
        default=3, ge=1, alias="CITIZEN_CONFIRMATIONS_TO_VERIFY"
    )
    # Whether a photo from the public must be reviewed before it appears on the public
    # map. On by default: anyone can send anything to a bot.
    citizen_images_require_review: bool = Field(
        default=True, alias="CITIZEN_IMAGES_REQUIRE_REVIEW"
    )

    @field_validator("jwt_secret")
    @classmethod
    def _require_secret(cls, value: str) -> str:
        if not value:
            raise ValueError(
                "JWT_SECRET must be set. Generate one with `openssl rand -hex 32`; "
                "there is deliberately no default."
            )
        if len(value) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters.")
        return value

    @model_validator(mode="after")
    def _refuse_open_production(self) -> Settings:
        """An open API in production is not a configuration, it is an incident.

        Raised at startup rather than logged, for the same reason `JWT_SECRET` is: a
        deployment that got this wrong should fail to boot, not quietly serve everything
        to everyone.
        """
        if self.auth_disabled and self.environment.lower() in {"production", "prod"}:
            raise ValueError(
                "AUTH_DISABLED cannot be true when ENVIRONMENT is production. "
                "It exists for local demos only."
            )
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_bot_token)

    @property
    def report_deep_link(self) -> str:
        """Link that opens the bot ready to take a report.

        Empty when no bot username is configured, which the web UI treats as "hide the
        report button" rather than rendering a link that goes nowhere.
        """
        if not self.telegram_bot_username:
            return ""
        handle = self.telegram_bot_username.lstrip("@")
        return f"https://t.me/{handle}?start=report"

    @property
    def public_s3_endpoint(self) -> str:
        """Endpoint a browser can reach, which differs from the in-cluster one."""
        return self.s3_public_endpoint_url or self.s3_endpoint_url


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
