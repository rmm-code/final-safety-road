import { describe, expect, it } from "vitest";
import { DEFAULT_VISION_CONFIG } from "@pothole/vision-web";
import type { AnalysedPothole, VideoAnalysisResult } from "./analyse-video";
import { buildReport, reportFileName, summarise, toTrackSummary } from "./report";

function pothole(overrides: Partial<AnalysedPothole> = {}): AnalysedPothole {
  return {
    trackId: "track-001",
    firstSeenSeconds: 4.2,
    lastSeenSeconds: 5.1,
    bestFrameSeconds: 4.83,
    confidence: 0.94,
    severity: { level: "large", score: 0.82, confidence: 0.78, rationale: "test" },
    observationCount: 6,
    maxArea: 0.031,
    cropImage: null,
    fullImage: null,
    ...overrides,
  };
}

const SYNTHETIC_ENGINE = {
  kind: "mock" as const,
  modelVersion: "mock-synthetic-0.1.0",
  backend: "synthetic",
  isSynthetic: true,
  selectionReason: "No model deployed.",
};

function result(potholes: AnalysedPothole[]): VideoAnalysisResult {
  return {
    potholes,
    frames: [],
    framesAnalysed: 180,
    rejectedTracks: 4,
    rawDetections: 640,
    otherClasses: { Crack: 3, "Speed-Bump": 1 },
    durationSeconds: 30,
    width: 1920,
    height: 1080,
    averageInferenceMs: 12.5,
    engine: SYNTHETIC_ENGINE,
  };
}

describe("analysis summary", () => {
  it("counts unique potholes by visual severity", () => {
    const summary = summarise([
      pothole({ severity: { level: "small", score: 0.2, confidence: 0.6, rationale: "" } }),
      pothole({ severity: { level: "medium", score: 0.5, confidence: 0.7, rationale: "" } }),
      pothole({ severity: { level: "medium", score: 0.5, confidence: 0.7, rationale: "" } }),
      pothole({ severity: { level: "large", score: 0.9, confidence: 0.8, rationale: "" } }),
    ]);

    expect(summary).toMatchObject({ total: 4, small: 1, medium: 2, large: 1, unknown: 0 });
  });

  it("averages peak confidence across potholes, not across frames", () => {
    const summary = summarise([pothole({ confidence: 0.9 }), pothole({ confidence: 0.7 })]);
    expect(summary.averageConfidence).toBeCloseTo(0.8, 10);
  });

  it("reports zero rather than NaN when nothing was detected", () => {
    expect(summarise([])).toEqual({
      total: 0,
      small: 0,
      medium: 0,
      large: 0,
      unknown: 0,
      averageConfidence: 0,
    });
  });
});

describe("exported report", () => {
  it("matches the documented per-track shape", () => {
    expect(toTrackSummary(pothole())).toEqual({
      trackId: "track-001",
      firstSeenSeconds: 4.2,
      lastSeenSeconds: 5.1,
      maxConfidence: 0.94,
      severity: "large",
      severityScore: 0.82,
      severityConfidence: 0.78,
      observationCount: 6,
      maxArea: 0.031,
      bestFrameSeconds: 4.83,
    });
  });

  it("records what the model saw but did not report", () => {
    const report = buildReport({
      result: result([pothole()]),
      fileName: "drive.mp4",
      config: DEFAULT_VISION_CONFIG,
    });
    // Cracks and speed bumps are recognised and counted, never turned into potholes.
    expect(report.analysis.otherClasses).toEqual({ Crack: 3, "Speed-Bump": 1 });
    expect(report.summary.totalPotholes).toBe(1);
  });

  it("records the engine so synthetic runs stay identifiable after export", () => {
    const report = buildReport({
      result: result([pothole()]),
      fileName: "tashkent-drive.mp4",
      config: DEFAULT_VISION_CONFIG,
    });

    expect(report.engine.isSynthetic).toBe(true);
    expect(report.engine.modelVersion).toBe("mock-synthetic-0.1.0");
  });

  it("states that an uploaded file has no location instead of inventing coordinates", () => {
    const report = buildReport({
      result: result([pothole()]),
      fileName: "drive.mp4",
      config: DEFAULT_VISION_CONFIG,
    });

    expect(report.location.available).toBe(false);
    expect(report.location.reason).toMatch(/no GPS telemetry/i);
    expect(JSON.stringify(report)).not.toMatch(/latitude|longitude/i);
  });

  it("records the thresholds the run actually used", () => {
    const report = buildReport({
      result: result([]),
      fileName: "drive.mp4",
      config: DEFAULT_VISION_CONFIG,
      generatedAt: new Date("2026-08-16T18:42:00.000Z"),
    });

    expect(report.generatedAt).toBe("2026-08-16T18:42:00.000Z");
    expect(report.analysis).toEqual({
      sampleFps: DEFAULT_VISION_CONFIG.analysis.sampleFps,
      framesAnalysed: 180,
      confidenceThreshold: DEFAULT_VISION_CONFIG.detection.confidenceThreshold,
      iouMatchThreshold: DEFAULT_VISION_CONFIG.tracking.iouMatchThreshold,
      minObservations: DEFAULT_VISION_CONFIG.tracking.minObservations,
      rawDetections: 640,
      rejectedTracks: 4,
      otherClasses: { Crack: 3, "Speed-Bump": 1 },
    });
    expect(report.summary.totalPotholes).toBe(0);
  });
});

describe("cross-implementation compatibility", () => {
  it("carries the analysis counters the Python CLI also emits", () => {
    const report = buildReport({
      result: result([pothole()]),
      fileName: "drive.mp4",
      config: DEFAULT_VISION_CONFIG,
    });
    // The browser and the CLI emit one schema, so a report from either can be compared
    // with the other without a translation step.
    expect(report.analysis.rawDetections).toBe(640);
    expect(report.analysis.rejectedTracks).toBe(4);
  });
});

describe("report file naming", () => {
  it.each([
    ["tashkent-drive.mp4", "tashkent-drive-detections.json"],
    ["Drive 2026 08 16.MOV", "Drive-2026-08-16-detections.json"],
    ["....", "analysis-detections.json"],
  ])("derives %s -> %s", (input, expected) => {
    expect(reportFileName(input)).toBe(expected);
  });
});
