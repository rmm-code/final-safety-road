import type { BoundingBox } from "@pothole/shared-types";
import { iou } from "./geometry";

export type ScoredBox<T> = {
  box: BoundingBox;
  score: number;
  payload: T;
};

/**
 * Greedy non-maximum suppression. Keeps the highest-scoring box, discards every
 * remaining box that overlaps it beyond `iouThreshold`, repeats.
 *
 * Suppression is per class: boxes are only compared with boxes of the same classId.
 */
export function nonMaximumSuppression<T extends { classId: number }>(
  candidates: ScoredBox<T>[],
  iouThreshold: number,
  maxOutput: number,
): ScoredBox<T>[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept: ScoredBox<T>[] = [];

  for (const candidate of sorted) {
    if (kept.length >= maxOutput) break;
    const suppressed = kept.some(
      (k) =>
        k.payload.classId === candidate.payload.classId &&
        iou(k.box, candidate.box) > iouThreshold,
    );
    if (!suppressed) kept.push(candidate);
  }

  return kept;
}
