import type { BoundingBox, CapturedFrame } from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import { areaScore, centralityScore } from "./scores";

export type FrameCandidateInput = {
  confidence: number;
  bbox: BoundingBox;
  /**
   * 0..1 sharpness. Omit when pixel data is unavailable; the term then contributes a
   * neutral 1.0 rather than silently penalising the frame.
   */
  sharpness?: number;
};

/**
 * Chooses the strongest evidence frame for a pothole track.
 *
 * The first frame of a track is usually the worst one: the pothole is far away, small
 * and often clipped. Candidates are scored as a weighted product of detector
 * confidence, visible area, sharpness and distance from the frame edge, and only the
 * best frame is kept.
 *
 * Scoring is separated from capture on purpose: scoring is cheap and runs every
 * frame, while encoding an image is expensive and runs only when a candidate wins.
 */
export class BestFrameSelector {
  private readonly config: VisionConfig;
  private readonly best = new Map<string, CapturedFrame>();

  constructor(config: VisionConfig) {
    this.config = config;
  }

  /** Weighted product of the quality terms. Higher is better; always > 0. */
  score(input: FrameCandidateInput): number {
    const { weights, edgeMargin, edgeClipPenalty } = this.config.bestFrame;
    const confidence = Math.max(input.confidence, 1e-6);
    const area = Math.max(areaScore(input.bbox.width * input.bbox.height, this.config.severity.areaScoreReference), 1e-6);
    const sharpness = Math.max(input.sharpness ?? 1, 1e-6);
    const centrality = Math.max(centralityScore(input.bbox, edgeMargin, edgeClipPenalty), 1e-6);

    return (
      Math.pow(confidence, weights.confidence) *
      Math.pow(area, weights.area) *
      Math.pow(sharpness, weights.sharpness) *
      Math.pow(centrality, weights.centrality)
    );
  }

  /**
   * True when a candidate with this score would replace the stored best frame.
   * Call before doing any image encoding work.
   */
  wouldAccept(trackId: string, score: number): boolean {
    const current = this.best.get(trackId);
    return current === undefined || score > current.score;
  }

  /** Store a captured frame as the best one for this track. */
  commit(trackId: string, frame: CapturedFrame): void {
    const current = this.best.get(trackId);
    if (current && current.score >= frame.score) return;
    this.best.set(trackId, frame);
  }

  peek(trackId: string): CapturedFrame | undefined {
    return this.best.get(trackId);
  }

  /** Retrieve and release the best frame for a track. */
  take(trackId: string): CapturedFrame | undefined {
    const frame = this.best.get(trackId);
    this.best.delete(trackId);
    return frame;
  }

  /** Release a track's candidate without using it, e.g. when the track is rejected. */
  discard(trackId: string): void {
    this.best.delete(trackId);
  }
}
