import type { BoundingBox, NormalisedPoint } from "@pothole/shared-types";

/** Area of a normalised box, clamped at zero for degenerate boxes. */
export function boxArea(box: BoundingBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/** Centroid of a normalised box. */
export function boxCentroid(box: BoundingBox): NormalisedPoint {
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/** Intersection area of two normalised boxes. */
export function intersectionArea(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * Intersection over union. Returns 0 when either box is degenerate, so callers never
 * have to guard against NaN from a zero-area union.
 */
export function iou(a: BoundingBox, b: BoundingBox): number {
  const intersection = intersectionArea(a, b);
  if (intersection === 0) return 0;
  const union = boxArea(a) + boxArea(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Clamp a box into the unit square, preserving as much of it as remains visible. */
export function clampBoxToFrame(box: BoundingBox): BoundingBox {
  const left = Math.min(Math.max(box.x, 0), 1);
  const top = Math.min(Math.max(box.y, 0), 1);
  const right = Math.min(Math.max(box.x + box.width, 0), 1);
  const bottom = Math.min(Math.max(box.y + box.height, 0), 1);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Shift a box by a delta, without clamping. Used by the tracker's motion model. */
export function translateBox(box: BoundingBox, dx: number, dy: number): BoundingBox {
  return { x: box.x + dx, y: box.y + dy, width: box.width, height: box.height };
}
