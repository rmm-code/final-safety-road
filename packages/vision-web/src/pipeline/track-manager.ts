import type {
  BoundingBox,
  Detection,
  DetectionObservation,
  PotholeTrack,
  TrackState,
} from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import { boxArea, boxCentroid, iou } from "../postprocess/geometry";
import { isInTriggerRegion } from "./trigger-region";
import { createSequentialIdFactory } from "../util/id";

/** Centre-form view of a box, so motion and growth can be extrapolated independently. */
type CentreForm = { cx: number; cy: number; width: number; height: number };

function centreForm(box: BoundingBox): CentreForm {
  return {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    width: box.width,
    height: box.height,
  };
}

function subtract(a: CentreForm, b: CentreForm): CentreForm {
  return { cx: a.cx - b.cx, cy: a.cy - b.cy, width: a.width - b.width, height: a.height - b.height };
}

/** Apparent size can grow quickly, but never by more than this per prediction. */
const MAX_SCALE_GROWTH = 4;
/** A predicted centre never jumps more than this fraction of the frame. */
const MAX_CENTRE_SHIFT = 0.6;

function clampScale(predicted: number, current: number): number {
  const lower = current / MAX_SCALE_GROWTH;
  const upper = current * MAX_SCALE_GROWTH;
  return Math.min(upper, Math.max(lower, predicted));
}

function clampShift(delta: number): number {
  return Math.min(MAX_CENTRE_SHIFT, Math.max(-MAX_CENTRE_SHIFT, delta));
}

export type TrackUpdateContext = {
  /** Milliseconds. Media time for video analysis, epoch time for live capture. */
  timestampMs: number;
  /** Index of the analysed frame, incremented once per inference. */
  frameIndex: number;
};

export type TrackUpdateResult = {
  /** Tracks that received a detection in this frame. */
  matched: PotholeTrack[];
  /** Tracks created by this frame. */
  created: PotholeTrack[];
  /** Tracks that reached a terminal outcome in this frame. */
  closed: PotholeTrack[];
};

/**
 * Converts repeated per-frame detections into one local pothole track.
 *
 * A pothole appears in many consecutive frames. Counting every frame as a new pothole
 * would inflate results by an order of magnitude, so association happens here and
 * only finalised tracks become events.
 *
 * Association is IoU-based with an optional constant-velocity prediction step.
 * Prediction matters because the vehicle is moving: between two analysed frames a
 * pothole travels a long way down the image, and raw IoU alone starts missing
 * matches at low sample rates. ByteTrack or optical flow can replace this later
 * without changing the interface.
 */
export class TrackManager {
  private readonly config: VisionConfig;
  private readonly nextId: () => string;
  private tracks: PotholeTrack[] = [];
  private finalized: PotholeTrack[] = [];
  private rejected: PotholeTrack[] = [];

  constructor(config: VisionConfig, options?: { idPrefix?: string }) {
    this.config = config;
    this.nextId = createSequentialIdFactory(options?.idPrefix ?? "track");
  }

  /** Tracks still being followed. */
  get activeTracks(): readonly PotholeTrack[] {
    return this.tracks;
  }

  /** Number of tracks closed so far, whether confirmed or rejected. */
  get closedCount(): number {
    return this.finalized.length + this.rejected.length;
  }

  update(detections: readonly Detection[], context: TrackUpdateContext): TrackUpdateResult {
    const usable = detections.filter(
      (d) => d.confidence >= this.config.detection.confidenceThreshold && boxArea(d.bbox) > 0,
    );

    const pairs: { trackIndex: number; detectionIndex: number; score: number }[] = [];
    this.tracks.forEach((track, trackIndex) => {
      const predicted = this.predictBox(track);
      usable.forEach((detection, detectionIndex) => {
        const score = this.associationScore(predicted, detection.bbox);
        if (score !== null) pairs.push({ trackIndex, detectionIndex, score });
      });
    });

    // Greedy assignment, strongest overlap first. Sufficient for the handful of
    // simultaneous potholes a single lane produces.
    pairs.sort((a, b) => b.score - a.score);
    const usedTracks = new Set<number>();
    const usedDetections = new Set<number>();
    const matched: PotholeTrack[] = [];

    for (const pair of pairs) {
      if (usedTracks.has(pair.trackIndex) || usedDetections.has(pair.detectionIndex)) continue;
      usedTracks.add(pair.trackIndex);
      usedDetections.add(pair.detectionIndex);
      const track = this.tracks[pair.trackIndex] as PotholeTrack;
      const detection = usable[pair.detectionIndex] as Detection;
      this.appendObservation(track, detection, context);
      matched.push(track);
    }

    const created: PotholeTrack[] = [];
    usable.forEach((detection, detectionIndex) => {
      if (usedDetections.has(detectionIndex)) return;
      created.push(this.createTrack(detection, context));
    });

    const closed: PotholeTrack[] = [];
    const survivors: PotholeTrack[] = [];
    this.tracks.forEach((track, trackIndex) => {
      if (usedTracks.has(trackIndex)) {
        survivors.push(track);
        return;
      }
      track.missedFrames += 1;
      if (track.missedFrames > this.config.tracking.maxMissedFrames) {
        this.closeTrack(track);
        closed.push(track);
      } else {
        survivors.push(track);
      }
    });

    this.tracks = [...survivors, ...created];
    return { matched, created, closed };
  }

  /**
   * Close every remaining track. Called at the end of a video or drive session so
   * that a pothole visible in the final frames is not silently dropped.
   */
  flush(): PotholeTrack[] {
    const closed = this.tracks;
    closed.forEach((track) => this.closeTrack(track));
    this.tracks = [];
    return closed;
  }

  /** Confirmed tracks that are ready to become events. Drains the buffer. */
  takeFinalizedTracks(): PotholeTrack[] {
    const out = this.finalized;
    this.finalized = [];
    return out;
  }

  /**
   * Tracks that closed without meeting the promotion rules. Kept so the UI can report
   * how much was filtered out instead of discarding it invisibly.
   */
  takeRejectedTracks(): PotholeTrack[] {
    const out = this.rejected;
    this.rejected = [];
    return out;
  }

  /**
   * How well a detection matches a track's predicted position, or null when it does
   * not match at all.
   *
   * Overlap is the primary signal. The proximity fallback exists because close to the
   * vehicle a pothole can move further than its own height between analysed frames, at
   * which point IoU is exactly zero however good the prediction was. Proximity matches
   * always score below the IoU gate, so a genuine overlap always wins the greedy
   * assignment.
   */
  private associationScore(predicted: BoundingBox, candidate: BoundingBox): number | null {
    const { iouMatchThreshold, centreDistanceGate, scaleRatioGate } = this.config.tracking;

    const overlap = iou(predicted, candidate);
    if (overlap >= iouMatchThreshold) return overlap;
    if (centreDistanceGate <= 0) return null;

    const predictedArea = boxArea(predicted);
    const candidateArea = boxArea(candidate);
    if (predictedArea <= 0 || candidateArea <= 0) return null;

    const ratio = candidateArea / predictedArea;
    if (ratio > scaleRatioGate || ratio < 1 / scaleRatioGate) return null;

    const [px, py] = boxCentroid(predicted);
    const [cx, cy] = boxCentroid(candidate);
    const distance = Math.hypot(px - cx, py - cy);
    const radius =
      (Math.hypot(predicted.width, predicted.height) + Math.hypot(candidate.width, candidate.height)) / 4;
    if (radius <= 0) return null;

    const normalised = distance / radius;
    if (normalised > centreDistanceGate) return null;

    // Scaled into (0, iouMatchThreshold) so proximity never outranks real overlap.
    return iouMatchThreshold * 0.99 * (1 - normalised / centreDistanceGate);
  }

  /**
   * Where the track is expected to be in this frame.
   *
   * A pothole approaching the camera does not move at a constant image speed: under
   * perspective its row position and its apparent size both accelerate as the vehicle
   * closes in. A constant-velocity model therefore lags exactly where it matters most,
   * at close range, and the biggest, clearest observations break away into fragments -
   * which both inflates the pothole count and makes severity read too small.
   *
   * So the prediction extrapolates centre AND size, with an acceleration term once
   * three observations are available. Extrapolation is bounded: a noisy pair of frames
   * must not throw the predicted box across the image.
   */
  private predictBox(track: PotholeTrack): BoundingBox {
    const count = track.observations.length;
    const last = track.observations[count - 1];
    if (!last) throw new Error(`Track ${track.localTrackId} has no observations`);
    if (!this.config.tracking.motionPrediction || count < 2) return last.detection.bbox;

    const previous = track.observations[count - 2] as DetectionObservation;
    const current = centreForm(last.detection.bbox);
    const before = centreForm(previous.detection.bbox);

    const velocity = subtract(current, before);
    let acceleration: CentreForm = { cx: 0, cy: 0, width: 0, height: 0 };
    if (count >= 3) {
      const earlier = centreForm((track.observations[count - 3] as DetectionObservation).detection.bbox);
      acceleration = subtract(velocity, subtract(before, earlier));
    }

    // Steps since the last match: a track that briefly disappeared is still predicted
    // at a plausible position rather than at the place it was last seen.
    const steps = Math.max(1, track.missedFrames + 1);
    const rampedSteps = (steps * (steps + 1)) / 2;

    const predictedWidth = clampScale(
      current.width + velocity.width * steps + acceleration.width * rampedSteps,
      current.width,
    );
    const predictedHeight = clampScale(
      current.height + velocity.height * steps + acceleration.height * rampedSteps,
      current.height,
    );
    const predictedCx = current.cx + clampShift(velocity.cx * steps + acceleration.cx * rampedSteps);
    const predictedCy = current.cy + clampShift(velocity.cy * steps + acceleration.cy * rampedSteps);

    return {
      x: predictedCx - predictedWidth / 2,
      y: predictedCy - predictedHeight / 2,
      width: predictedWidth,
      height: predictedHeight,
    };
  }

  private createTrack(detection: Detection, context: TrackUpdateContext): PotholeTrack {
    const track: PotholeTrack = {
      localTrackId: this.nextId(),
      state: "CANDIDATE",
      firstSeenAt: context.timestampMs,
      lastSeenAt: context.timestampMs,
      maxConfidence: detection.confidence,
      maxArea: boxArea(detection.bbox),
      observations: [this.toObservation(detection, context)],
      missedFrames: 0,
      finalized: false,
    };
    return track;
  }

  private appendObservation(
    track: PotholeTrack,
    detection: Detection,
    context: TrackUpdateContext,
  ): void {
    track.observations.push(this.toObservation(detection, context));
    track.lastSeenAt = context.timestampMs;
    track.maxConfidence = Math.max(track.maxConfidence, detection.confidence);
    track.maxArea = Math.max(track.maxArea, boxArea(detection.bbox));
    track.missedFrames = 0;
    track.state = this.nextState(track);
  }

  private toObservation(detection: Detection, context: TrackUpdateContext): DetectionObservation {
    return {
      timestampMs: context.timestampMs,
      frameIndex: context.frameIndex,
      detection,
      area: boxArea(detection.bbox),
      inTriggerRegion: isInTriggerRegion(detection.bbox, this.config.triggerRegion.topY),
    };
  }

  /** CANDIDATE -> TRACKING -> CONFIRMED, evaluated after every new observation. */
  private nextState(track: PotholeTrack): TrackState {
    if (this.meetsPromotionRules(track)) return "CONFIRMED";
    return track.observations.length >= 2 ? "TRACKING" : "CANDIDATE";
  }

  private meetsPromotionRules(track: PotholeTrack): boolean {
    const { minObservations, minMaxConfidence, minDurationMs } = this.config.tracking;
    return (
      track.observations.length >= minObservations &&
      track.maxConfidence >= minMaxConfidence &&
      track.lastSeenAt - track.firstSeenAt >= minDurationMs
    );
  }

  /**
   * Terminal transition. A confirmed track becomes FINALIZED and is handed to the
   * event pipeline; anything else is rejected.
   *
   * REJECTED_LOW_CONFIDENCE covers every promotion-rule failure (too few
   * observations, too low a peak confidence, or too short a track): from the
   * pipeline's point of view they are all "not enough evidence".
   */
  private closeTrack(track: PotholeTrack): void {
    if (this.meetsPromotionRules(track)) {
      track.state = "FINALIZED";
      track.finalized = true;
      this.finalized.push(track);
    } else {
      track.state = "REJECTED_LOW_CONFIDENCE";
      track.finalized = true;
      this.rejected.push(track);
    }
  }
}
