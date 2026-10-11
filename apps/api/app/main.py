"""Pothole Intelligence API.

A modular monolith: routes, services and repositories in one deployable process. There is
no case yet for splitting this, and several against.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.deps import SettingsDep
from app.api.v1 import api_router
from app.core.config import get_settings
from app.db.session import dispose_engine


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    try:
        from app.services.storage import ObjectStorage

        ObjectStorage(settings).ensure_bucket()
    except Exception:
        # Storage being unreachable at boot must not stop the API: sightings are still
        # recorded, they simply arrive without evidence images until it returns.
        pass
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="Pothole Intelligence API",
        version="0.1.0",
        description="Internal road-damage detection and mapping.",
        lifespan=lifespan,
    )

    # Explicit origins, never "*": the API is credentialed.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        # PUT for placing a saved video on the map (`/video-analyses/{id}/location`).
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    app.include_router(api_router)

    @app.get("/health", tags=["ops"])
    async def health(request_settings: SettingsDep) -> dict[str, str]:
        # Resolved per request rather than closed over: the module-level `settings` above
        # is read once at startup, which made this endpoint report the configuration the
        # process booted with instead of the one it is serving.
        #
        # `auth` is reported so an open deployment is visible without reading its
        # environment. A demo and a real deployment must not look identical here.
        return {
            "status": "ok",
            "environment": request_settings.environment,
            "auth": "disabled" if request_settings.auth_disabled else "required",
        }

    return app


app = create_app()
