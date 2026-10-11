"""The id an analysis is saved under, identical to features/videos/lib/analysis-id.ts."""

from __future__ import annotations

import hashlib


def _js_number(value: float) -> str:
    """How JavaScript prints a number: 12 not 12.0, 0.35 as is."""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def analysis_id(source: str, model_version: str, threshold: float, sample_fps: float) -> str:
    text = "|".join([source, model_version, _js_number(threshold), _js_number(sample_fps)])
    raw = bytearray(hashlib.sha256(text.encode()).digest()[:16])
    raw[6] = (raw[6] & 0x0F) | 0x80
    raw[8] = (raw[8] & 0x3F) | 0x80
    h = raw.hex()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"
