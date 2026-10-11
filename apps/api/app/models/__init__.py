"""SQLAlchemy models.

The central rule of this schema: a `DetectionEvent` is a SIGHTING and a `Pothole` is a
physical defect in the road. Many sightings belong to one pothole. Nothing may assume
that an incoming event creates a new pothole.

There are two kinds of sighting and they are separate tables: `DetectionEvent` is what our
own detector saw from a moving vehicle, `CitizenReport` is what a person reported through
Telegram. Both resolve to a `Pothole` through the same deduplication service.

`VideoAnalysis` is neither: a road video analysed in a browser and saved for replay. A
video file has no GPS, so it never produces sightings or potholes, even once a person
places it on the map.
"""

from app.models.citizen_report import CitizenReport
from app.models.detection_event import DetectionEvent
from app.models.device import Device
from app.models.drive_session import DriveSession
from app.models.model_version import ModelVersion
from app.models.pothole import Pothole
from app.models.pothole_status_history import PotholeStatusHistory
from app.models.telegram_draft import TelegramReportDraft
from app.models.user import User
from app.models.video_analysis import VideoAnalysis, VideoAnalysisPothole

__all__ = [
    "CitizenReport",
    "DetectionEvent",
    "Device",
    "DriveSession",
    "ModelVersion",
    "Pothole",
    "PotholeStatusHistory",
    "TelegramReportDraft",
    "User",
    "VideoAnalysis",
    "VideoAnalysisPothole",
]
