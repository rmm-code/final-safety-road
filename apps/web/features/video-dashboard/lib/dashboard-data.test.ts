import { describe, expect, it } from "vitest";
import type { AnalysedPothole, SampledFrame } from "@/features/analyze/lib/analyse-video";
import {
  activityBuckets,
  confidenceAt,
  confidenceSeries,
  formatClock,
  severityCounts,
  timelineRows,
} from "./dashboard-data";

function pothole(trackId: string, level: AnalysedPothole["severity"]["level"], at = 1): AnalysedPothole {
  return {
    trackId,
    firstSeenSeconds: at,
    lastSeenSeconds: at + 0.5,
    bestFrameSeconds: at,
    confidence: 0.6,
    severity: { level, score: 0.5, confidence: 0.7, rationale: "" },
    observationCount: 4,
    maxArea: 0.01,
    cropImage: null,
    fullImage: null,
  };
}

function frame(seconds: number, ...detections: [number, string | null][]): SampledFrame {
  return {
    seconds,
    detections: detections.map(([confidence, trackId]) => ({
      trackId,
      detection: {
        classId: 0,
        className: "pothole",
        confidence,
        bbox: { x: 0, y: 0, width: 0.1, height: 0.1 },
      },
    })),
  } as SampledFrame;
}

describe("dashboard numbers", () => {
  it("counts potholes by severity, every level present even at zero", () => {
    expect(severityCounts([pothole("a", "large"), pothole("b", "small"), pothole("c", "small")])).toEqual({
      large: 1,
      medium: 0,
      small: 2,
      unknown: 0,
    });
  });

  it("splits detections per slice of the clip into confirmed potholes and the rest", () => {
    const frames = [frame(1, [0.7, "a"], [0.3, null]), frame(6, [0.5, "rejected"]), frame(9, [0.8, "a"])];

    const buckets = activityBuckets(frames, [pothole("a", "small")], 10, 2);

    expect(buckets).toEqual([
      { startSeconds: 0, endSeconds: 5, confirmed: 1, unconfirmed: 1 },
      { startSeconds: 5, endSeconds: 10, confirmed: 1, unconfirmed: 1 },
    ]);
  });

  it("takes the most confident pothole in each frame, and zero where there was none", () => {
    const series = confidenceSeries([frame(0), frame(0.5, [0.4, null], [0.72, "a"]), frame(1, [0.2, null])]);

    expect(series).toEqual([
      { seconds: 0, confidence: 0 },
      { seconds: 0.5, confidence: 0.72 },
      { seconds: 1, confidence: 0.2 },
    ]);
  });

  it("reads the confidence at a moment from the last frame at or before it", () => {
    const series = [
      { seconds: 0, confidence: 0.1 },
      { seconds: 1, confidence: 0.9 },
    ];

    expect(confidenceAt(series, 0.6)).toBe(0.1);
    expect(confidenceAt(series, 1.4)).toBe(0.9);
    expect(confidenceAt([], 3)).toBe(0);
  });

  it("orders timeline rows from worst to ungraded", () => {
    const rows = timelineRows([pothole("a", "small"), pothole("b", "large"), pothole("c", "unknown")]);

    expect(rows.map((row) => [row.label, row.potholes.length])).toEqual([
      ["Large", 1],
      ["Medium", 0],
      ["Small", 1],
      ["Not graded", 1],
    ]);
  });

  it("writes clip times as minutes and seconds", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(22.4)).toBe("00:22");
    expect(formatClock(340)).toBe("05:40");
  });
});
