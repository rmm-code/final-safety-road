import { describe, expect, it } from "vitest";
import type {
  DetectionObservation,
  LocationSample,
  PotholeTrack,
  SeverityResult,
} from "@pothole/shared-types";
import { DEFAULT_VISION_CONFIG } from "../config/vision-config";
import { EventBuilder } from "./event-builder";
import { LocationBuffer } from "./location-buffer";

const SEVERITY: SeverityResult = {
  level: "large",
  score: 0.82,
  confidence: 0.78,
  rationale: "test",
};

function observation(
  timestampMs: number,
  inTriggerRegion: boolean,
  frameIndex: number,
): DetectionObservation {
  return {
    timestampMs,
    frameIndex,
    detection: {
      classId: 0,
      className: "pothole",
      confidence: 0.9,
      bbox: { x: 0.4, y: inTriggerRegion ? 0.8 : 0.5, width: 0.12, height: 0.08 },
    },
    area: 0.0096,
    inTriggerRegion,
  };
}

function track(observations: DetectionObservation[], maxConfidence = 0.92): PotholeTrack {
  return {
    localTrackId: "track-001",
    state: "FINALIZED",
    firstSeenAt: observations[0]?.timestampMs ?? 0,
    lastSeenAt: observations[observations.length - 1]?.timestampMs ?? 0,
    maxConfidence,
    maxArea: 0.0096,
    observations,
    missedFrames: 0,
    finalized: true,
  };
}

function locations(samples: [number, number, number][]): LocationBuffer {
  const buffer = new LocationBuffer();
  samples.forEach(([timestamp, lat, lng]) => {
    const sample: LocationSample = {
      timestamp,
      lat,
      lng,
      accuracyM: 8.4,
      speedMps: 12.5,
      headingDeg: 123,
    };
    buffer.add(sample);
  });
  return buffer;
}

const builder = new EventBuilder(DEFAULT_VISION_CONFIG);
const newId = () => "11111111-2222-3333-4444-555555555555";

describe("EventBuilder geolocation rule", () => {
  it("uses the moment the pothole reached the trigger region, not first sight", () => {
    // Seen far ahead at 10 s, reached the vehicle at 13 s. Saving the 10 s position
    // would put the marker tens of metres before the real defect.
    const result = builder.fromTrack({
      track: track([
        observation(10_000, false, 0),
        observation(11_000, false, 1),
        observation(13_000, true, 2),
      ]),
      severity: SEVERITY,
      driveSessionId: "session-1",
      locations: locations([
        [10_000, 41.3, 69.2],
        [13_000, 41.31, 69.28],
      ]),
      modelVersion: "pothole-detector-0.1.0",
      newId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locatedAtMs).toBe(13_000);
    expect(result.event.latitude).toBe(41.31);
    expect(result.event.longitude).toBe(69.28);
  });

  it("falls back to the closest approach when the trigger region was never reached", () => {
    const result = builder.fromTrack({
      track: track([observation(10_000, false, 0), observation(11_000, false, 1)]),
      severity: SEVERITY,
      driveSessionId: "session-1",
      locations: locations([
        [10_000, 41.3, 69.2],
        [11_000, 41.305, 69.25],
      ]),
      modelVersion: "m",
      newId,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.locatedAtMs).toBe(11_000);
  });

  it("takes the first trigger-region observation, not the last", () => {
    const result = builder.fromTrack({
      track: track([
        observation(10_000, false, 0),
        observation(12_000, true, 1),
        observation(12_500, true, 2),
      ]),
      severity: SEVERITY,
      driveSessionId: "s",
      locations: locations([[12_000, 41.31, 69.28]]),
      modelVersion: "m",
      newId,
    });
    expect(result.ok && result.locatedAtMs).toBe(12_000);
  });
});

describe("EventBuilder rejections", () => {
  it("rejects an event with no usable GPS rather than guessing a position", () => {
    const result = builder.fromTrack({
      track: track([observation(13_000, true, 0)]),
      severity: SEVERITY,
      driveSessionId: "s",
      locations: locations([]),
      modelVersion: "m",
      newId,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("REJECTED_NO_LOCATION");
  });

  it("rejects when the only fix is far from the sighting in time", () => {
    const result = builder.fromTrack({
      track: track([observation(60_000, true, 0)]),
      severity: SEVERITY,
      driveSessionId: "s",
      locations: locations([[10_000, 41.3, 69.2]]),
      modelVersion: "m",
      newId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("REJECTED_NO_LOCATION");
  });

  it("rejects a track whose peak confidence never cleared the bar", () => {
    const result = builder.fromTrack({
      track: track([observation(13_000, true, 0)], 0.3),
      severity: SEVERITY,
      driveSessionId: "s",
      locations: locations([[13_000, 41.31, 69.28]]),
      modelVersion: "m",
      newId,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("REJECTED_LOW_CONFIDENCE");
  });
});

describe("EventBuilder payload", () => {
  const result = builder.fromTrack({
    track: track([observation(13_000, true, 0)]),
    severity: SEVERITY,
    driveSessionId: "session-abc",
    locations: locations([[13_000, 41.3112, 69.2797]]),
    modelVersion: "pothole-detector-0.1.0",
    newId,
  });

  it("matches the documented event schema", () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toEqual({
      clientEventId: "11111111-2222-3333-4444-555555555555",
      driveSessionId: "session-abc",
      detectedAt: new Date(13_000).toISOString(),
      confidence: 0.92,
      severity: "large",
      severityScore: 0.82,
      severityConfidence: 0.78,
      latitude: 41.3112,
      longitude: 69.2797,
      locationAccuracyM: 8.4,
      headingDeg: 123,
      speedMps: 12.5,
      modelVersion: "pothole-detector-0.1.0",
    });
  });

  it("always carries the reported location accuracy", () => {
    // A consumer must never treat a phone coordinate as exact.
    expect(result.ok && result.event.locationAccuracyM).toBe(8.4);
  });

  it("gives every event a distinct client id so retries stay idempotent", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const built = builder.fromTrack({
        track: track([observation(13_000, true, 0)]),
        severity: SEVERITY,
        driveSessionId: "s",
        locations: locations([[13_000, 41.31, 69.28]]),
        modelVersion: "m",
        newId: () => `id-${i}`,
      });
      if (built.ok) ids.add(built.event.clientEventId);
    }
    expect(ids.size).toBe(5);
  });
});
