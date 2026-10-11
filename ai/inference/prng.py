"""Deterministic pseudo-random generator (mulberry32).

Bit-compatible with ``packages/vision-web/src/util/prng.ts`` so the synthetic engine
behaves the same way in the browser and in the offline CLI. The synthetic pipeline must
never use the system RNG or the wall clock: analysing the same input twice has to give
the same report.
"""

from __future__ import annotations

from collections.abc import Callable

_MASK = 0xFFFFFFFF


def create_prng(seed: int) -> Callable[[], float]:
    state = seed & _MASK

    def rand() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _MASK
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & _MASK
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & _MASK)) & _MASK)) & _MASK
        return ((t ^ (t >> 14)) & _MASK) / 4294967296

    return rand


def random_between(rand: Callable[[], float], minimum: float, maximum: float) -> float:
    return minimum + rand() * (maximum - minimum)
