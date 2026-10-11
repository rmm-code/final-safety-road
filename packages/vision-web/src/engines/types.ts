import type { Detection, VisionEngineInfo } from "@pothole/shared-types";

/**
 * The contract every detector implementation satisfies.
 *
 * Nothing outside this package may depend on onnxruntime, a server response shape or
 * any model's native output. Swapping the detector must never require touching the
 * product code.
 */
export interface VisionEngine {
  init(): Promise<void>;
  infer(source: CanvasImageSource): Promise<Detection[]>;
  dispose(): Promise<void>;
}

export type VisionEngineStats = {
  inferenceCount: number;
  /** Milliseconds taken by the most recent inference. */
  lastInferenceMs: number;
  /** Exponential moving average of inference duration, in milliseconds. */
  averageInferenceMs: number;
};

/**
 * A VisionEngine that can describe itself. Every implementation in this package is
 * described, so the UI can always state which engine and model version produced the
 * detections on screen, and exports can record it.
 */
export interface DescribedVisionEngine extends VisionEngine {
  readonly info: VisionEngineInfo;
  readonly stats: VisionEngineStats;
  /**
   * Running tally of confident detections the engine recognised but did not report,
   * by class name. Empty for a single-class model.
   *
   * Observability, not a product feature: nothing downstream may turn these into events.
   * They exist so an operator can see that the detector found 40 cracks on a road where
   * we reported 3 potholes, which is the evidence for whether cracks deserve modelling.
   */
  readonly otherClassCounts: Readonly<Record<string, number>>;
  /** True while an inference is in flight. Callers must skip frames instead of queueing. */
  isBusy(): boolean;
  /**
   * Restart any internal sequence so an identical input produces an identical result.
   * Only the synthetic engine carries such state; model-backed engines are stateless
   * between frames and do not implement it.
   */
  reset?(): void;
}

/** Shared timing bookkeeping so every engine reports stats the same way. */
export class InferenceTimer {
  private count = 0;
  private last = 0;
  private average = 0;

  get snapshot(): VisionEngineStats {
    return {
      inferenceCount: this.count,
      lastInferenceMs: this.last,
      averageInferenceMs: this.average,
    };
  }

  record(durationMs: number): void {
    this.count += 1;
    this.last = durationMs;
    // Exponential moving average: recent frames matter more on a thermally throttled phone.
    this.average = this.count === 1 ? durationMs : this.average * 0.8 + durationMs * 0.2;
  }
}

/** Wall-clock reading that works in browsers, workers and Node test environments. */
export function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
