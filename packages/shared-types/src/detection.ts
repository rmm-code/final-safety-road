import type { BoundingBox, NormalisedPoint } from "./geometry";

/**
 * The only class the MVP detector emits. Severity is deliberately NOT a detector
 * class: it is derived later by the SeverityEngine so severity can be improved
 * without retraining the detector.
 */
export type DetectionClassName = "pothole";

/**
 * Normalised model output. Vision engines must translate whatever their underlying
 * runtime produces (YOLO tensors, server JSON, synthetic data) into this shape.
 * Nothing downstream may depend on a specific model's output layout.
 */
export type Detection = {
  classId: number;
  className: DetectionClassName;
  /** 0..1 detector confidence. */
  confidence: number;
  /** Normalised source-frame coordinates. */
  bbox: BoundingBox;
  /** Optional instance-segmentation contour, normalised source-frame coordinates. */
  polygon?: NormalisedPoint[];
};

/** A detection bound to the moment it was observed. */
export type DetectionObservation = {
  /** Milliseconds. Epoch time for live capture, media time for video analysis. */
  timestampMs: number;
  /** Monotonically increasing index of the analysed (not displayed) frame. */
  frameIndex: number;
  detection: Detection;
  /** Normalised bbox area, cached because severity and best-frame scoring both need it. */
  area: number;
  /** True when the detection centroid sits inside the configured trigger region. */
  inTriggerRegion: boolean;
};
