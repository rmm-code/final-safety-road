import type { BoundingBox } from "@pothole/shared-types";

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Map a normalised bounding-box area onto a 0..1 visual-size score.
 *
 * A square-root curve is used so that the small end of the range stays
 * discriminative: potholes occupy a small fraction of the frame, and a linear map
 * would compress every small and medium defect into the bottom few percent.
 */
export function areaScore(area: number, reference: number): number {
  if (reference <= 0) return 0;
  return clamp01(Math.sqrt(Math.max(0, area) / reference));
}

/**
 * Penalise boxes that touch a frame edge: part of the pothole is outside the image,
 * so both its apparent size and its evidence value are unreliable.
 * Returns `edgeClipPenalty` for a fully clipped box and 1 for a comfortably inset one.
 */
export function centralityScore(
  box: BoundingBox,
  edgeMargin: number,
  edgeClipPenalty: number,
): number {
  if (edgeMargin <= 0) return 1;
  const distances = [box.x, box.y, 1 - (box.x + box.width), 1 - (box.y + box.height)];
  const nearest = Math.min(...distances);
  const openness = clamp01(nearest / edgeMargin);
  return edgeClipPenalty + (1 - edgeClipPenalty) * openness;
}
