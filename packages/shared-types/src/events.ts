import type { SeverityLevel } from "./severity";
import type { VisionEngineInfo } from "./engine";

/**
 * Where a sighting's coordinates came from: the phone's own GPS fix, or a point an
 * operator placed on the map, because an uploaded video file carries no telemetry.
 */
export type LocationSource = "gps" | "manual";

/**
 * Payload uploaded for one pothole SIGHTING.
 *
 * A detection event is not a physical pothole. The server decides, by deduplication,
 * which physical pothole (if any) a sighting belongs to. Never assume one event
 * creates one pothole.
 */
export type DetectionEventPayload = {
  /** Client-generated UUID. Makes upload retries idempotent. */
  clientEventId: string;
  driveSessionId: string;
  /** ISO-8601 UTC. */
  detectedAt: string;
  confidence: number;
  severity: SeverityLevel;
  severityScore: number;
  severityConfidence: number;
  latitude: number;
  longitude: number;
  /** Reported GPS accuracy in metres. Required: coordinates are never exact. */
  locationAccuracyM: number;
  /**
   * Absent means "gps". "manual" marks a point placed by hand, which is stored and shown
   * as one: a hand-placed point must never pass for a GPS fix.
   */
  locationSource?: LocationSource;
  headingDeg: number | null;
  speedMps: number | null;
  modelVersion: string;
};

/** One unique pothole found in an analysed video. */
export type VideoTrackSummary = {
  trackId: string;
  firstSeenSeconds: number;
  lastSeenSeconds: number;
  /** Highest detector confidence observed across the track. */
  maxConfidence: number;
  severity: SeverityLevel;
  severityScore: number;
  severityConfidence: number;
  observationCount: number;
  /** Largest normalised bbox area observed across the track. */
  maxArea: number;
  /** Media time of the selected evidence frame, or null when none was captured. */
  bestFrameSeconds: number | null;
};

/**
 * Why no coordinates are attached to an analysis. Uploaded video files carry no
 * telemetry, and coordinates are never fabricated.
 */
export type LocationAvailability = {
  available: false;
  reason: string;
};

/** Complete result of analysing one video file. Emitted by the web app and the Python CLI. */
export type VideoAnalysisReport = {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    name: string;
    durationSeconds: number;
    width: number;
    height: number;
  };
  engine: VisionEngineInfo;
  analysis: {
    sampleFps: number;
    framesAnalysed: number;
    confidenceThreshold: number;
    iouMatchThreshold: number;
    minObservations: number;
    /** Raw per-frame detections, before tracking collapsed them into potholes. */
    rawDetections: number;
    /** Tracks that never met the confirmation rules. Reported, never hidden. */
    rejectedTracks: number;
    /**
     * Confident detections the model recognised but this product does not report,
     * by class name - cracks, speed bumps, vehicles.
     *
     * Recorded so it is visible what the detector saw beyond potholes. Nothing consumes
     * these as entities; they are the evidence for whether another defect type is worth
     * modelling on these roads.
     */
    otherClasses: Record<string, number>;
  };
  location: LocationAvailability;
  summary: {
    totalPotholes: number;
    small: number;
    medium: number;
    large: number;
    unknown: number;
    /** Mean of each track's max confidence, 0..1. Zero when nothing was found. */
    averageConfidence: number;
  };
  tracks: VideoTrackSummary[];
};
