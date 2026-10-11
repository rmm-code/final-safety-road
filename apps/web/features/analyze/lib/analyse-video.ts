import type {
  CapturedFrame,
  Detection,
  PotholeTrack,
  SeverityResult,
  VisionEngineInfo,
} from "@pothole/shared-types";
import {
  BestFrameSelector,
  TrackManager,
  VisualSeverityEngine,
  laplacianVariance,
  sharpnessScore,
  type DescribedVisionEngine,
  type VisionConfig,
} from "@pothole/vision-web";
import {
  createFrameCanvas,
  encodeRegion,
  get2dContext,
  seekTo,
  toPixelRect,
  waitForMetadata,
} from "./video-frames";

/** One unique physical-looking pothole found in the video. */
export type AnalysedPothole = {
  trackId: string;
  firstSeenSeconds: number;
  lastSeenSeconds: number;
  /** Media time of the evidence frame, or null when none could be captured. */
  bestFrameSeconds: number | null;
  /** Highest detector confidence across the track. */
  confidence: number;
  severity: SeverityResult;
  observationCount: number;
  maxArea: number;
  cropImage: string | null;
  fullImage: string | null;
};

/** A raw detection together with the track it was associated with, if any. */
export type FrameDetection = {
  detection: Detection;
  /**
   * Local track this detection was associated with, or null when it was not tracked
   * (below the confidence threshold, or an isolated blob). Keeping both lets the
   * overlay show what the detector produced next to what the pipeline actually counted.
   */
  trackId: string | null;
};

/** Detections recorded at one analysed media time, replayed as an overlay. */
export type SampledFrame = {
  seconds: number;
  detections: FrameDetection[];
};

export type AnalysisProgress = {
  framesAnalysed: number;
  totalFrames: number;
  currentSeconds: number;
  durationSeconds: number;
  potholesFound: number;
};

export type VideoAnalysisResult = {
  potholes: AnalysedPothole[];
  frames: SampledFrame[];
  framesAnalysed: number;
  /** Tracks that never met the confirmation rules. Reported, not hidden. */
  rejectedTracks: number;
  /** Total raw per-frame detections, before tracking collapsed them. */
  rawDetections: number;
  /** Classes the model recognised but this product does not report, by name. */
  otherClasses: Record<string, number>;
  durationSeconds: number;
  width: number;
  height: number;
  averageInferenceMs: number;
  engine: VisionEngineInfo;
};

export type AnalyseVideoOptions = {
  video: HTMLVideoElement;
  engine: DescribedVisionEngine;
  config: VisionConfig;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
};

const CROP_MAX_EDGE = 320;
const CROP_QUALITY = 0.82;
const FULL_FRAME_MAX_EDGE = 480;
const FULL_FRAME_QUALITY = 0.7;
/** Context kept around a pothole crop so the evidence image shows the road surface. */
const CROP_PADDING_RATIO = 0.35;

export class AnalysisAbortedError extends Error {
  constructor() {
    super("Analysis cancelled.");
    this.name = "AnalysisAbortedError";
  }
}

/**
 * Run the full local detection pipeline over a video file.
 *
 * The video is sampled at a fixed rate rather than every frame: the detector does not
 * need 30 FPS, and the same pipeline runs on a phone at 4-10 FPS. Per-frame detections
 * are associated into tracks, so the reported count is unique potholes, not sightings.
 */
export async function analyseVideo(options: AnalyseVideoOptions): Promise<VideoAnalysisResult> {
  const { video, engine, config, signal, onProgress } = options;

  await waitForMetadata(video);

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("This video reports no duration, so it cannot be analysed.");
  }

  const canvas = createFrameCanvas(video.videoWidth, video.videoHeight);
  const context = get2dContext(canvas);

  const tracker = new TrackManager(config);
  const severityEngine = new VisualSeverityEngine(config);
  const selector = new BestFrameSelector(config);

  const sampleFps = config.analysis.sampleFps;
  // Ceiling, not floor + 1: the last sample sits strictly before the end of the video,
  // because there is no frame at exactly `duration`. This matches the Python CLI, which
  // samples the frames it actually decodes.
  const totalFrames = Math.max(1, Math.ceil(duration * sampleFps));

  const potholes: AnalysedPothole[] = [];
  const frames: SampledFrame[] = [];
  let rejectedTracks = 0;
  let rawDetections = 0;
  let framesAnalysed = 0;

  const drainTracker = () => {
    for (const track of tracker.takeFinalizedTracks()) {
      potholes.push(buildPothole(track, severityEngine.calculate(track), selector.take(track.localTrackId)));
    }
    for (const track of tracker.takeRejectedTracks()) {
      selector.discard(track.localTrackId);
      rejectedTracks += 1;
    }
  };

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (signal?.aborted) throw new AnalysisAbortedError();

    const seconds = Math.min(duration, frameIndex / sampleFps);
    await seekTo(video, seconds);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const detections = await engine.infer(canvas);
    rawDetections += detections.length;
    framesAnalysed += 1;

    const update = tracker.update(detections, { timestampMs: seconds * 1000, frameIndex });

    // Map each detection back to the track that claimed it, by identity.
    const owners = new Map<Detection, string>();
    for (const track of [...update.matched, ...update.created]) {
      const observation = track.observations[track.observations.length - 1];
      if (observation && observation.frameIndex === frameIndex) {
        owners.set(observation.detection, track.localTrackId);
      }
      captureCandidateFrame({ track, canvas, context, selector, config, seconds, frameIndex });
    }

    frames.push({
      seconds,
      detections: detections.map((detection) => ({
        detection,
        trackId: owners.get(detection) ?? null,
      })),
    });

    drainTracker();

    onProgress?.({
      framesAnalysed,
      totalFrames,
      currentSeconds: seconds,
      durationSeconds: duration,
      potholesFound: potholes.length,
    });
  }

  tracker.flush();
  drainTracker();

  potholes.sort((a, b) => a.firstSeenSeconds - b.firstSeenSeconds);

  return {
    potholes,
    frames,
    framesAnalysed,
    rejectedTracks,
    rawDetections,
    otherClasses: { ...engine.otherClassCounts },
    durationSeconds: duration,
    width: video.videoWidth,
    height: video.videoHeight,
    averageInferenceMs: engine.stats.averageInferenceMs,
    engine: engine.info,
  };
}

/**
 * Offer the current frame to a track's best-frame selector.
 *
 * Scoring is cheap and runs on every frame; encoding runs only when the candidate wins,
 * because encoding every frame of every track would dominate the analysis time.
 */
function captureCandidateFrame(input: {
  track: PotholeTrack;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  selector: BestFrameSelector;
  config: VisionConfig;
  seconds: number;
  frameIndex: number;
}): void {
  const { track, canvas, context, selector, config, seconds, frameIndex } = input;
  const observation = track.observations[track.observations.length - 1];
  if (!observation || observation.frameIndex !== frameIndex) return;

  const bbox = observation.detection.bbox;
  const cropRect = toPixelRect(bbox, canvas.width, canvas.height);
  if (cropRect.width < 3 || cropRect.height < 3) return;

  let sharpness: number | undefined;
  try {
    const pixels = context.getImageData(cropRect.x, cropRect.y, cropRect.width, cropRect.height);
    sharpness = sharpnessScore(laplacianVariance(pixels), config.bestFrame.sharpnessHalfSaturation);
  } catch {
    // A tainted canvas would make pixel reads impossible; sharpness is optional, and
    // the selector treats a missing value as neutral rather than as blur.
    sharpness = undefined;
  }

  const score = selector.score({
    confidence: observation.detection.confidence,
    bbox,
    ...(sharpness === undefined ? {} : { sharpness }),
  });
  if (!selector.wouldAccept(track.localTrackId, score)) return;

  const paddedRect = toPixelRect(bbox, canvas.width, canvas.height, CROP_PADDING_RATIO);
  const frame: CapturedFrame = {
    timestampMs: seconds * 1000,
    frameIndex,
    score,
    confidence: observation.detection.confidence,
    bbox,
  };

  const cropImage = encodeRegion(canvas, paddedRect, CROP_MAX_EDGE, CROP_QUALITY);
  if (cropImage) frame.cropImage = cropImage;

  const fullImage = encodeRegion(
    canvas,
    { x: 0, y: 0, width: canvas.width, height: canvas.height },
    FULL_FRAME_MAX_EDGE,
    FULL_FRAME_QUALITY,
  );
  if (fullImage) frame.fullImage = fullImage;

  selector.commit(track.localTrackId, frame);
}

function buildPothole(
  track: PotholeTrack,
  severity: SeverityResult,
  bestFrame: CapturedFrame | undefined,
): AnalysedPothole {
  return {
    trackId: track.localTrackId,
    firstSeenSeconds: track.firstSeenAt / 1000,
    lastSeenSeconds: track.lastSeenAt / 1000,
    bestFrameSeconds: bestFrame ? bestFrame.timestampMs / 1000 : null,
    confidence: track.maxConfidence,
    severity,
    observationCount: track.observations.length,
    maxArea: track.maxArea,
    cropImage: bestFrame?.cropImage ?? null,
    fullImage: bestFrame?.fullImage ?? null,
  };
}
