import type { PotholeTrack, SeverityResult, VisionEngineInfo } from "@pothole/shared-types";
import {
  BestFrameSelector,
  EventBuilder,
  LocationBuffer,
  TrackManager,
  VisualSeverityEngine,
  type DescribedVisionEngine,
  type EventBuildResult,
  type VisionConfig,
} from "@pothole/vision-web";

export type CapturedImages = { fullImage?: string; cropImage?: string; sharpness?: number };

/** Captures evidence images for a detection, or nothing when pixels are unavailable. */
export type FrameCapturer = (bbox: {
  x: number;
  y: number;
  width: number;
  height: number;
}) => CapturedImages | null;

export type DriveEvent = {
  trackId: string;
  severity: SeverityResult;
  confidence: number;
  observationCount: number;
  /** Epoch milliseconds of the moment the pothole was located. */
  detectedAtMs: number;
  build: EventBuildResult;
  cropImage?: string;
  fullImage?: string;
};

export type DriveStats = {
  framesInferred: number;
  framesSkipped: number;
  /** Inference frames per second over the recent past. */
  inferenceFps: number;
  lastLatencyMs: number;
  averageLatencyMs: number;
  activeTracks: number;
  eventsBuilt: number;
  eventsRejected: number;
};

export type DriveRecorderOptions = {
  engine: DescribedVisionEngine;
  config: VisionConfig;
  locations: LocationBuffer;
  driveSessionId: string;
  /** Target inference rate. The camera preview runs independently and much faster. */
  targetFps?: number;
  onEvent: (event: DriveEvent) => void;
  now?: () => number;
  newId?: () => string;
};

/**
 * Runs the detection pipeline over a live camera.
 *
 * The two rules that matter here are about time. First, inference must never queue: if
 * the model is still working when the next frame arrives, that frame is dropped. A
 * detection computed from a frame that is half a second old describes road the vehicle
 * has already passed, so a fresh frame is always worth more than a complete one.
 *
 * Second, tracks are located by when they reached the trigger region, not when the
 * inference finished, so a slow frame does not drag the pothole's position forward.
 */
export class DriveRecorder {
  private readonly options: DriveRecorderOptions;
  private readonly tracker: TrackManager;
  private readonly severity: VisualSeverityEngine;
  private readonly selector: BestFrameSelector;
  private readonly events: EventBuilder;
  private readonly now: () => number;
  private readonly minFrameGapMs: number;

  private busy = false;
  // Negative infinity so the very first frame is analysed immediately rather than
  // waiting out a frame gap that has not started yet.
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private frameIndex = 0;
  private framesInferred = 0;
  private framesSkipped = 0;
  private eventsBuilt = 0;
  private eventsRejected = 0;
  private lastLatencyMs = 0;
  private averageLatencyMs = 0;
  private recentInferenceTimes: number[] = [];

  constructor(options: DriveRecorderOptions) {
    this.options = options;
    this.tracker = new TrackManager(options.config);
    this.severity = new VisualSeverityEngine(options.config);
    this.selector = new BestFrameSelector(options.config);
    this.events = new EventBuilder(options.config);
    this.now = options.now ?? (() => Date.now());
    const targetFps = options.targetFps ?? options.config.analysis.sampleFps;
    this.minFrameGapMs = 1000 / Math.max(1, targetFps);
  }

  get engineInfo(): VisionEngineInfo {
    return this.options.engine.info;
  }

  /** Tracks currently being followed, for the live overlay. */
  get activeTracks(): readonly PotholeTrack[] {
    return this.tracker.activeTracks;
  }

  get stats(): DriveStats {
    return {
      framesInferred: this.framesInferred,
      framesSkipped: this.framesSkipped,
      inferenceFps: this.currentFps(),
      lastLatencyMs: this.lastLatencyMs,
      averageLatencyMs: this.averageLatencyMs,
      activeTracks: this.tracker.activeTracks.length,
      eventsBuilt: this.eventsBuilt,
      eventsRejected: this.eventsRejected,
    };
  }

  /**
   * Offer the current camera frame. Returns true when it was analysed.
   * Safe to call on every animation frame; pacing and skipping happen here.
   */
  async tick(source: CanvasImageSource, capture?: FrameCapturer): Promise<boolean> {
    const startedAt = this.now();

    if (this.busy) {
      this.framesSkipped += 1;
      return false;
    }
    if (startedAt - this.lastSampleAt < this.minFrameGapMs) {
      return false;
    }

    this.busy = true;
    this.lastSampleAt = startedAt;

    try {
      const detections = await this.options.engine.infer(source);
      const finishedAt = this.now();
      this.recordLatency(finishedAt - startedAt);

      const frameIndex = this.frameIndex;
      this.frameIndex += 1;
      this.framesInferred += 1;

      // Timestamped at capture, not completion: a slow inference must not shift the
      // pothole's position along the road.
      const update = this.tracker.update(detections, { timestampMs: startedAt, frameIndex });

      for (const track of [...update.matched, ...update.created]) {
        this.considerEvidence(track, frameIndex, startedAt, capture);
      }

      this.drain();
      return true;
    } finally {
      this.busy = false;
    }
  }

  /** Close every open track at the end of a drive so nothing in view is lost. */
  finish(): void {
    this.tracker.flush();
    this.drain();
  }

  private drain(): void {
    for (const track of this.tracker.takeFinalizedTracks()) {
      const severity = this.severity.calculate(track);
      const best = this.selector.take(track.localTrackId);
      const build = this.events.fromTrack({
        track,
        severity,
        driveSessionId: this.options.driveSessionId,
        locations: this.options.locations,
        modelVersion: this.options.engine.info.modelVersion,
        ...(this.options.newId ? { newId: this.options.newId } : {}),
      });

      if (build.ok) this.eventsBuilt += 1;
      else this.eventsRejected += 1;

      this.options.onEvent({
        trackId: track.localTrackId,
        severity,
        confidence: track.maxConfidence,
        observationCount: track.observations.length,
        detectedAtMs: build.ok ? build.locatedAtMs : track.lastSeenAt,
        build,
        ...(best?.cropImage ? { cropImage: best.cropImage } : {}),
        ...(best?.fullImage ? { fullImage: best.fullImage } : {}),
      });
    }

    for (const track of this.tracker.takeRejectedTracks()) {
      this.selector.discard(track.localTrackId);
    }
  }

  private considerEvidence(
    track: PotholeTrack,
    frameIndex: number,
    timestampMs: number,
    capture?: FrameCapturer,
  ): void {
    const observation = track.observations[track.observations.length - 1];
    if (!observation || observation.frameIndex !== frameIndex) return;

    const images = capture?.(observation.detection.bbox) ?? null;
    const score = this.selector.score({
      confidence: observation.detection.confidence,
      bbox: observation.detection.bbox,
      ...(images?.sharpness === undefined ? {} : { sharpness: images.sharpness }),
    });
    if (!this.selector.wouldAccept(track.localTrackId, score)) return;

    this.selector.commit(track.localTrackId, {
      timestampMs,
      frameIndex,
      score,
      confidence: observation.detection.confidence,
      bbox: observation.detection.bbox,
      ...(images?.fullImage ? { fullImage: images.fullImage } : {}),
      ...(images?.cropImage ? { cropImage: images.cropImage } : {}),
    });
  }

  private recordLatency(durationMs: number): void {
    this.lastLatencyMs = durationMs;
    this.averageLatencyMs =
      this.framesInferred === 0 ? durationMs : this.averageLatencyMs * 0.8 + durationMs * 0.2;

    const now = this.now();
    this.recentInferenceTimes.push(now);
    // Keep a 3 s window so the reading reacts to thermal throttling quickly.
    while (this.recentInferenceTimes.length > 0 && now - (this.recentInferenceTimes[0] as number) > 3000) {
      this.recentInferenceTimes.shift();
    }
  }

  private currentFps(): number {
    if (this.recentInferenceTimes.length < 2) return 0;
    const first = this.recentInferenceTimes[0] as number;
    const last = this.recentInferenceTimes[this.recentInferenceTimes.length - 1] as number;
    const span = last - first;
    return span <= 0 ? 0 : ((this.recentInferenceTimes.length - 1) / span) * 1000;
  }
}
