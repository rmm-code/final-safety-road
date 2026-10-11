"""Bounding-box geometry.

Every box that crosses a module boundary is in NORMALISED source-frame coordinates
(0..1, origin top-left), exactly as in ``packages/vision-web``. Pixel coordinates exist
only inside rendering and cropping code.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BoundingBox:
    x: float
    y: float
    width: float
    height: float

    @property
    def area(self) -> float:
        return max(0.0, self.width) * max(0.0, self.height)

    @property
    def centre(self) -> tuple[float, float]:
        return (self.x + self.width / 2, self.y + self.height / 2)

    def clamped(self) -> BoundingBox:
        """Clip into the unit square, keeping whatever part of the box is visible."""
        left = min(max(self.x, 0.0), 1.0)
        top = min(max(self.y, 0.0), 1.0)
        right = min(max(self.x + self.width, 0.0), 1.0)
        bottom = min(max(self.y + self.height, 0.0), 1.0)
        return BoundingBox(left, top, max(0.0, right - left), max(0.0, bottom - top))

    def to_pixels(
        self, width: int, height: int, padding_ratio: float = 0.0
    ) -> tuple[int, int, int, int]:
        """Integer pixel rect (x, y, w, h) clipped to a frame of the given size."""
        pad_x = self.width * padding_ratio
        pad_y = self.height * padding_ratio
        left = max(0, int((self.x - pad_x) * width))
        top = max(0, int((self.y - pad_y) * height))
        right = min(width, int(round((self.x + self.width + pad_x) * width)))
        bottom = min(height, int(round((self.y + self.height + pad_y) * height)))
        return left, top, max(0, right - left), max(0, bottom - top)


def intersection_area(a: BoundingBox, b: BoundingBox) -> float:
    left = max(a.x, b.x)
    top = max(a.y, b.y)
    right = min(a.x + a.width, b.x + b.width)
    bottom = min(a.y + a.height, b.y + b.height)
    if right <= left or bottom <= top:
        return 0.0
    return (right - left) * (bottom - top)


def iou(a: BoundingBox, b: BoundingBox) -> float:
    """Intersection over union; 0 for degenerate boxes rather than a division error."""
    overlap = intersection_area(a, b)
    if overlap == 0.0:
        return 0.0
    union = a.area + b.area - overlap
    return overlap / union if union > 0 else 0.0


def polygon_area(points: list[tuple[float, float]] | None) -> float:
    """Area of a normalised polygon by the shoelace formula.

    Returns 0 for a degenerate contour, so callers can fall back to the bounding box.
    """
    if not points or len(points) < 3:
        return 0.0
    total = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2
