import { describe, expect, it } from "vitest";
import type { DetectionObservation, PotholeTrack } from "@pothole/shared-types";
import { DEFAULT_VISION_CONFIG, resolveVisionConfig } from "../config/vision-config";
import { VisualSeverityEngine } from "./severity-engine";

const { areaScoreReference, smallMax, mediumMax } = DEFAULT_VISION_CONFIG.severity;

/** Normalised area whose severity score lands exactly on `score`. */
const areaForScore = (score: number) => score * score * areaScoreReference;

function observation(area: number, inTriggerRegion = true, index = 0): DetectionObservation {
  const width = Math.sqrt(area / 0.6);
  const height = area / width;
  return {
    timestampMs: index * 167,
    frameIndex: index,
    detection: {
      classId: 0,
      className: "pothole",
      confidence: 0.9,
      bbox: { x: 0.4, y: 0.75, width, height },
    },
    area,
    inTriggerRegion,
  };
}

function track(areas: number[], options?: { inTriggerRegion?: boolean; maxConfidence?: number }): PotholeTrack {
  const observations = areas.map((area, index) =>
    observation(area, options?.inTriggerRegion ?? true, index),
  );
  return {
    localTrackId: "track-001",
    state: "CONFIRMED",
    firstSeenAt: 0,
    lastSeenAt: Math.max(0, (areas.length - 1) * 167),
    maxConfidence: options?.maxConfidence ?? 0.9,
    maxArea: Math.max(0, ...areas),
    observations,
    missedFrames: 0,
    finalized: false,
  };
}

describe("VisualSeverityEngine thresholds", () => {
  const engine = new VisualSeverityEngine(DEFAULT_VISION_CONFIG);

  it("classifies a small pothole", () => {
    const result = engine.calculate(track([areaForScore(smallMax - 0.05)]));
    expect(result.level).toBe("small");
  });

  it("treats the small/medium boundary as small", () => {
    const result = engine.calculate(track([areaForScore(smallMax)]));
    expect(result.score).toBeCloseTo(smallMax, 6);
    expect(result.level).toBe("small");
  });

  it("classifies a medium pothole just above the boundary", () => {
    expect(engine.calculate(track([areaForScore(smallMax + 0.01)])).level).toBe("medium");
  });

  it("treats the medium/large boundary as medium", () => {
    expect(engine.calculate(track([areaForScore(mediumMax)])).level).toBe("medium");
  });

  it("classifies a large pothole just above the boundary", () => {
    expect(engine.calculate(track([areaForScore(mediumMax + 0.01)])).level).toBe("large");
  });

  it("saturates the score at 1 for an enormous defect", () => {
    const result = engine.calculate(track([0.5]));
    expect(result.score).toBe(1);
    expect(result.level).toBe("large");
  });

  it("moves the bands when the configuration changes, without code changes", () => {
    const strict = new VisualSeverityEngine(
      resolveVisionConfig({ severity: { smallMax: 0.1, mediumMax: 0.2 } }),
    );
    const sample = track([areaForScore(0.5)]);
    expect(new VisualSeverityEngine(DEFAULT_VISION_CONFIG).calculate(sample).level).toBe("medium");
    expect(strict.calculate(sample).level).toBe("large");
  });
});

describe("VisualSeverityEngine measurement choice", () => {
  const engine = new VisualSeverityEngine(DEFAULT_VISION_CONFIG);

  it("measures inside the trigger region and ignores distant observations", () => {
    const mixed = track([areaForScore(0.9), areaForScore(0.4)]);
    // The larger observation is far from the vehicle and must not drive severity.
    mixed.observations[0]!.inTriggerRegion = false;
    const result = engine.calculate(mixed);
    expect(result.score).toBeCloseTo(0.4, 6);
    expect(result.rationale).toContain("trigger region");
  });

  it("falls back to the full frame when the pothole never reached the trigger region", () => {
    const result = engine.calculate(track([areaForScore(0.5)], { inTriggerRegion: false }));
    expect(result.score).toBeCloseTo(0.5, 6);
    expect(result.rationale).toContain("full frame");
  });

  it("returns unknown for a track with no observations", () => {
    const empty = track([]);
    const result = engine.calculate(empty);
    expect(result.level).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  it("returns unknown when every observation has zero area", () => {
    expect(engine.calculate(track([0])).level).toBe("unknown");
  });
});

describe("VisualSeverityEngine confidence", () => {
  const engine = new VisualSeverityEngine(DEFAULT_VISION_CONFIG);

  it("rewards persistence, detector confidence and trigger-region evidence", () => {
    const weak = engine.calculate(
      track([areaForScore(0.5)], { inTriggerRegion: false, maxConfidence: 0.6 }),
    );
    const strong = engine.calculate(
      track(Array.from({ length: 10 }, () => areaForScore(0.5)), { maxConfidence: 0.95 }),
    );
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(strong.confidence).toBeLessThanOrEqual(1);
    expect(weak.confidence).toBeGreaterThan(0);
  });

  it("reaches full confidence only with a long, confident, close-range track", () => {
    const ideal = engine.calculate(
      track(
        Array.from({ length: DEFAULT_VISION_CONFIG.severity.persistenceReferenceObservations }, () =>
          areaForScore(0.8),
        ),
        { maxConfidence: 1 },
      ),
    );
    expect(ideal.confidence).toBeCloseTo(1, 10);
  });

  it("explains which features drove the result", () => {
    const result = engine.calculate(track([areaForScore(0.5), areaForScore(0.5)]));
    expect(result.rationale).toMatch(/Peak visible area/);
    expect(result.rationale).toMatch(/observation\(s\)/);
  });
});
