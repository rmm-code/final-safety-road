import type {
  DetectionEventPayload,
  LocationSample,
  PotholeTrack,
  SeverityResult,
} from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import type { LocationBuffer } from "./location-buffer";

export type EventRejectionReason = "REJECTED_NO_LOCATION" | "REJECTED_LOW_CONFIDENCE";

export type EventBuildResult =
  | { ok: true; event: DetectionEventPayload; locatedAtMs: number }
  | { ok: false; reason: EventRejectionReason; detail: string };

export type BuildEventInput = {
  track: PotholeTrack;
  severity: SeverityResult;
  driveSessionId: string;
  locations: LocationBuffer;
  modelVersion: string;
  /** Injected so builds are deterministic under test. */
  newId?: () => string;
};

/**
 * Turns a finalised local track into an uploadable sighting.
 *
 * The important decision here is *which* moment the coordinate comes from. A pothole is
 * first detected while it is still far ahead - saving the vehicle's position at that
 * instant would place the marker many metres before the real defect. So the builder
 * looks for the observation where the pothole entered the trigger region, near the bottom
 * of the frame, and takes the GPS sample closest to that timestamp.
 *
 * A live-drive event without a position is not useful and is rejected rather than
 * uploaded with a guess.
 */
export class EventBuilder {
  private readonly config: VisionConfig;

  constructor(config: VisionConfig) {
    this.config = config;
  }

  fromTrack(input: BuildEventInput): EventBuildResult {
    const { track, severity, driveSessionId, locations, modelVersion } = input;

    if (track.maxConfidence < this.config.tracking.minMaxConfidence) {
      return {
        ok: false,
        reason: "REJECTED_LOW_CONFIDENCE",
        detail: `Peak confidence ${track.maxConfidence.toFixed(2)} is below the ${this.config.tracking.minMaxConfidence} minimum.`,
      };
    }

    const locatedAtMs = this.locationTimestampFor(track);
    const sample = locations.nearestTo(locatedAtMs);

    if (!sample) {
      return {
        ok: false,
        reason: "REJECTED_NO_LOCATION",
        detail: "No GPS sample close enough to the moment the pothole passed the trigger region.",
      };
    }

    const newId = input.newId ?? defaultId;

    return {
      ok: true,
      locatedAtMs,
      event: {
        clientEventId: newId(),
        driveSessionId,
        detectedAt: new Date(locatedAtMs).toISOString(),
        confidence: round(track.maxConfidence, 4),
        severity: severity.level,
        severityScore: round(severity.score, 4),
        severityConfidence: round(severity.confidence, 4),
        latitude: sample.lat,
        longitude: sample.lng,
        locationAccuracyM: sample.accuracyM,
        headingDeg: sample.headingDeg,
        speedMps: sample.speedMps,
        modelVersion,
      },
    };
  }

  /**
   * The moment to locate the pothole by: when it reached the trigger region.
   *
   * Falls back to the last sighting when the track never got that far, which is the
   * closest the vehicle ever came to it.
   */
  private locationTimestampFor(track: PotholeTrack): number {
    const triggerObservations = track.observations.filter((o) => o.inTriggerRegion);
    const chosen = triggerObservations[0] ?? track.observations[track.observations.length - 1];
    return chosen?.timestampMs ?? track.lastSeenAt;
  }
}

function defaultId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  throw new Error("crypto.randomUUID is unavailable; pass newId explicitly");
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type { LocationSample };
