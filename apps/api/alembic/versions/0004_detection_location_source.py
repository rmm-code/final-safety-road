"""Where a sighting's coordinates came from: the phone's GPS, or a person's hand.

Revision ID: 0004
Revises: 0003

An uploaded video file carries no GPS, and coordinates are never fabricated, so the only
way to map a file's potholes is for an operator to place the clip on the map. Stored in
the same columns as a GPS fix, that point would be indistinguishable from one. The source
is recorded with the sighting instead, so a hand-placed point is labelled wherever it is
shown.

Every row that exists before this migration came from a phone, so the server default
labels them all "gps". The allowed values live in
`app.models.detection_event.LOCATION_SOURCES`, not in a check constraint, as statuses do.

Autogenerate also proposed dropping PostGIS's own tables (`spatial_ref_sys`, the tiger
geocoder's) and swapping several unique constraints for unique indexes. None of that is
this change, and it has been removed.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "detection_events",
        sa.Column("location_source", sa.String(length=16), server_default="gps", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("detection_events", "location_source")
