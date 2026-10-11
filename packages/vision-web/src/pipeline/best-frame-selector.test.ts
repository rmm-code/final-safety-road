import { describe, expect, it } from "vitest";
import type { CapturedFrame } from "@pothole/shared-types";
import { DEFAULT_VISION_CONFIG } from "../config/vision-config";
import { BestFrameSelector } from "./best-frame-selector";
import { laplacianVariance, sharpnessScore } from "./frame-quality";

const selector = new BestFrameSelector(DEFAULT_VISION_CONFIG);

const distant = { confidence: 0.85, bbox: { x: 0.47, y: 0.45, width: 0.03, height: 0.02 } };
const close = { confidence: 0.85, bbox: { x: 0.4, y: 0.7, width: 0.18, height: 0.12 } };

describe("BestFrameSelector scoring", () => {
  it("prefers a close pothole over the first distant sighting", () => {
    expect(selector.score(close)).toBeGreaterThan(selector.score(distant));
  });

  it("prefers the more confident of two identical frames", () => {
    expect(selector.score({ ...close, confidence: 0.95 })).toBeGreaterThan(selector.score(close));
  });

  it("prefers the sharper of two identical frames", () => {
    expect(selector.score({ ...close, sharpness: 0.9 })).toBeGreaterThan(
      selector.score({ ...close, sharpness: 0.2 }),
    );
  });

  it("treats missing sharpness as neutral rather than as blur", () => {
    expect(selector.score(close)).toBe(selector.score({ ...close, sharpness: 1 }));
  });

  it("penalises a pothole clipped by the frame edge", () => {
    const clipped = { confidence: 0.85, bbox: { x: 0, y: 0.7, width: 0.18, height: 0.12 } };
    expect(selector.score(clipped)).toBeLessThan(selector.score(close));
  });

  it("never returns a non-positive score", () => {
    const degenerate = { confidence: 0, bbox: { x: 0, y: 0, width: 0, height: 0 }, sharpness: 0 };
    expect(selector.score(degenerate)).toBeGreaterThan(0);
  });
});

describe("BestFrameSelector bookkeeping", () => {
  function frame(score: number): CapturedFrame {
    return {
      timestampMs: 0,
      frameIndex: 0,
      score,
      confidence: 0.9,
      bbox: { x: 0.4, y: 0.7, width: 0.1, height: 0.1 },
    };
  }

  it("accepts the first candidate and then only improvements", () => {
    const s = new BestFrameSelector(DEFAULT_VISION_CONFIG);
    expect(s.wouldAccept("track-001", 0.1)).toBe(true);
    s.commit("track-001", frame(0.5));
    expect(s.wouldAccept("track-001", 0.4)).toBe(false);
    expect(s.wouldAccept("track-001", 0.6)).toBe(true);
  });

  it("keeps the best frame when a weaker one is committed anyway", () => {
    const s = new BestFrameSelector(DEFAULT_VISION_CONFIG);
    s.commit("track-001", frame(0.8));
    s.commit("track-001", frame(0.2));
    expect(s.peek("track-001")!.score).toBe(0.8);
  });

  it("releases a frame exactly once", () => {
    const s = new BestFrameSelector(DEFAULT_VISION_CONFIG);
    s.commit("track-001", frame(0.8));
    expect(s.take("track-001")!.score).toBe(0.8);
    expect(s.take("track-001")).toBeUndefined();
  });

  it("discards candidates for rejected tracks", () => {
    const s = new BestFrameSelector(DEFAULT_VISION_CONFIG);
    s.commit("track-001", frame(0.8));
    s.discard("track-001");
    expect(s.peek("track-001")).toBeUndefined();
  });

  it("keeps tracks independent", () => {
    const s = new BestFrameSelector(DEFAULT_VISION_CONFIG);
    s.commit("track-001", frame(0.8));
    expect(s.wouldAccept("track-002", 0.1)).toBe(true);
  });
});

describe("sharpness measurement", () => {
  function grid(fill: (x: number, y: number) => number, size = 16) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const index = (y * size + x) * 4;
        const value = fill(x, y);
        data[index] = value;
        data[index + 1] = value;
        data[index + 2] = value;
        data[index + 3] = 255;
      }
    }
    return { data, width: size, height: size };
  }

  it("reports no high-frequency energy for a flat crop", () => {
    expect(laplacianVariance(grid(() => 128))).toBe(0);
  });

  it("reports more energy for a sharp edge than for a smooth gradient", () => {
    const sharp = laplacianVariance(grid((x) => (x < 8 ? 0 : 255)));
    const smooth = laplacianVariance(grid((x) => x * 16));
    expect(sharp).toBeGreaterThan(smooth);
  });

  it("maps variance onto a bounded 0..1 score", () => {
    const half = DEFAULT_VISION_CONFIG.bestFrame.sharpnessHalfSaturation;
    expect(sharpnessScore(0, half)).toBe(0);
    expect(sharpnessScore(half, half)).toBeCloseTo(0.5, 10);
    expect(sharpnessScore(1e9, half)).toBeGreaterThan(0.99);
  });

  it("returns zero for a crop too small to measure", () => {
    expect(laplacianVariance(grid(() => 200, 2))).toBe(0);
  });
});
