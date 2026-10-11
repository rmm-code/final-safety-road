import type { BoundingBox } from "@pothole/shared-types";
import { boxCentroid } from "../postprocess/geometry";

/**
 * The trigger region is the lower band of the frame. A pothole that reaches it is
 * close to the vehicle, which is when both its apparent size and the vehicle's GPS
 * position are the most useful. Saving a location the moment a distant pothole first
 * appears would place the marker many metres too early.
 */
export function isInTriggerRegion(box: BoundingBox, topY: number): boolean {
  const [, centreY] = boxCentroid(box);
  return centreY >= topY;
}

/** Fraction of the box's area that lies inside the trigger region. */
export function triggerRegionCoverage(box: BoundingBox, topY: number): number {
  if (box.height <= 0) return 0;
  const overlap = Math.max(0, box.y + box.height - Math.max(box.y, topY));
  return Math.min(1, overlap / box.height);
}
