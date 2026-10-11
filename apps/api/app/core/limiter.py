"""A small fixed-window rate limiter held in process memory."""

from __future__ import annotations

import time
from collections import defaultdict


class FixedWindowLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, list[float]] = defaultdict(list)

    def allow(self, identity: str, limit_per_minute: int, now: float | None = None) -> bool:
        current = now if now is not None else time.monotonic()
        window_start = current - 60
        hits = [t for t in self._hits[identity] if t >= window_start]
        hits.append(current)
        self._hits[identity] = hits
        return len(hits) <= limit_per_minute

    def reset(self) -> None:
        self._hits.clear()


limiter = FixedWindowLimiter()
