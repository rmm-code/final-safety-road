from __future__ import annotations

import numpy as np
import pytest

from ai.inference.config import VisionConfig, load_vision_config


@pytest.fixture(scope="session")
def config() -> VisionConfig:
    return load_vision_config()


@pytest.fixture(scope="session")
def synthetic_video(tmp_path_factory: pytest.TempPathFactory):
    """A short generated clip, so no binary fixture has to live in the repository."""
    import cv2

    path = tmp_path_factory.mktemp("video") / "road.mp4"
    width, height, fps, seconds = 320, 180, 12, 14
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))
    assert writer.isOpened(), "OpenCV could not open an mp4v writer"

    rng = np.random.default_rng(7)
    for index in range(fps * seconds):
        frame = np.full((height, width, 3), 60, dtype=np.uint8)
        frame[height // 2 :] = 90
        frame += rng.integers(0, 6, size=frame.shape, dtype=np.uint8)
        # A moving lane marking, so successive frames genuinely differ.
        offset = (index * 7) % width
        frame[height - 40 : height - 20, offset : offset + 12] = 200
        writer.write(frame)
    writer.release()
    return path
