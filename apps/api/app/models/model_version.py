from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, created_at_column, uuid_pk


class ModelVersion(Base):
    """Registry of deployed detectors.

    A deployed version is never overwritten, which is what makes it possible to explain
    months later why a particular pothole was reported.
    """

    __tablename__ = "model_versions"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    version: Mapped[str] = mapped_column(String(60), nullable=False)
    task: Mapped[str] = mapped_column(String(32), nullable=False, default="detect")
    dataset_version: Mapped[str | None] = mapped_column(String(120))
    metrics: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = created_at_column()

    __table_args__ = (UniqueConstraint("name", "version", name="uq_model_versions_name_version"),)
