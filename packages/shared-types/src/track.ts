import type { BoundingBox } from "./geometry";
import type { DetectionObservation } from "./detection";
import type { SeverityResult } from "./severity";

/**
 * Lifecycle of one local pothole track.
 *
 * IDLE -> CANDIDATE -> TRACKING -> CONFIRMED -> FINALIZED -> PENDING_UPLOAD -> UPLOADED
 *
 * Milestone 0 drives states up to FINALIZED. PENDING_UPLOAD / UPLOADED / UPLOAD_RETRY
 * are owned by the offline event queue and are introduced with the upload pipeline.
 */
export type TrackState =
  | "IDLE"
  | "CANDIDATE"
  | "TRACKING"
  | "CONFIRMED"
  | "FINALIZED"
  | "PENDING_UPLOAD"
  | "UPLOADED"
  | "REJECTED_LOW_CONFIDENCE"
  | "REJECTED_NO_LOCATION"
  | "UPLOAD_RETRY";

/** Terminal states: a track in one of these never transitions again. */
export const TERMINAL_TRACK_STATES: readonly TrackState[] = [
  "UPLOADED",
  "REJECTED_LOW_CONFIDENCE",
  "REJECTED_NO_LOCATION",
];

/** Evidence image captured for a track. */
export type CapturedFrame = {
  timestampMs: number;
  frameIndex: number;
  /** Quality score produced by the BestFrameSelector. */
  score: number;
  /** Detector confidence of the detection in this frame. */
  confidence: number;
  bbox: BoundingBox;
  /** Full road frame, encoded (data URL or object URL). */
  fullImage?: string;
  /** Cropped pothole image, encoded (data URL or object URL). */
  cropImage?: string;
};

export type PotholeTrack = {
  localTrackId: string;
  state: TrackState;
  /** Milliseconds, same clock as DetectionObservation.timestampMs. */
  firstSeenAt: number;
  lastSeenAt: number;
  maxConfidence: number;
  /** Largest normalised bbox area seen across the track. */
  maxArea: number;
  observations: DetectionObservation[];
  /** Consecutive analysed frames in which the track was not matched. */
  missedFrames: number;
  bestFrame?: CapturedFrame;
  severity?: SeverityResult;
  finalized: boolean;
};
