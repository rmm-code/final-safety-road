import { describe, expect, it } from "vitest";
import type { Detection } from "@pothole/shared-types";
import { DEFAULT_VISION_CONFIG } from "../config/vision-config";
import { MockVisionEngine } from "./mock-vision-engine";
import { TrackManager } from "../pipeline/track-manager";
import { VisualSeverityEngine } from "../pipeline/severity-engine";

// The synthetic engine ignores its input entirely; a placeholder is enough.
const SOURCE = null as unknown as CanvasImageSource;

async function sequence(engine: MockVisionEngine, frames: number): Promise<Detection[][]> {
  const out: Detection[][] = [];
  for (let i = 0; i < frames; i += 1) out.push(await engine.infer(SOURCE));
  return out;
}

describe("MockVisionEngine labelling", () => {
  it("declares itself synthetic with a mock-prefixed model version", async () => {
    const engine = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    await engine.init();
    expect(engine.info.isSynthetic).toBe(true);
    expect(engine.info.kind).toBe("mock");
    expect(engine.info.modelVersion.startsWith("mock-")).toBe(true);
  });

  it("refuses to run before initialisation", async () => {
    const engine = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    await expect(engine.infer(SOURCE)).rejects.toThrow(/before init/);
  });

  it("records inference statistics", async () => {
    const engine = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    await engine.init();
    await sequence(engine, 3);
    expect(engine.stats.inferenceCount).toBe(3);
    expect(engine.isBusy()).toBe(false);
  });
});

describe("MockVisionEngine determinism", () => {
  it("produces identical output for the same seed", async () => {
    const a = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    const b = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    await a.init();
    await b.init();
    expect(await sequence(a, 60)).toEqual(await sequence(b, 60));
  });

  it("produces different output for a different seed", async () => {
    const a = new MockVisionEngine(DEFAULT_VISION_CONFIG, { seed: 1 });
    const b = new MockVisionEngine(DEFAULT_VISION_CONFIG, { seed: 2 });
    await a.init();
    await b.init();
    expect(await sequence(a, 60)).not.toEqual(await sequence(b, 60));
  });

  it("reproduces its sequence after a reset", async () => {
    const engine = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    await engine.init();
    const first = await sequence(engine, 40);
    engine.reset();
    expect(await sequence(engine, 40)).toEqual(first);
  });

  it("emits boxes that stay inside the frame", async () => {
    const engine = new MockVisionEngine(DEFAULT_VISION_CONFIG);
    await engine.init();
    for (const frame of await sequence(engine, 200)) {
      for (const d of frame) {
        expect(d.bbox.x).toBeGreaterThanOrEqual(0);
        expect(d.bbox.y).toBeGreaterThanOrEqual(0);
        expect(d.bbox.x + d.bbox.width).toBeLessThanOrEqual(1 + 1e-9);
        expect(d.bbox.y + d.bbox.height).toBeLessThanOrEqual(1 + 1e-9);
        expect(d.confidence).toBeGreaterThan(0);
        expect(d.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("synthetic end-to-end pipeline", () => {
  /**
   * Runs the synthetic engine through the real tracker and severity engine, which is
   * how /analyze behaves with no model deployed. This is a pipeline sanity check, not
   * a measure of detection quality: the input is fabricated.
   */
  it("turns many frame detections into a much smaller number of unique potholes", async () => {
    const config = DEFAULT_VISION_CONFIG;
    const engine = new MockVisionEngine(config);
    await engine.init();

    const tracker = new TrackManager(config);
    const severity = new VisualSeverityEngine(config);
    const frameMs = 1000 / config.analysis.sampleFps;
    const frames = config.analysis.sampleFps * 120; // two minutes of driving

    let rawDetections = 0;
    for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
      const detections = await engine.infer(SOURCE);
      rawDetections += detections.length;
      tracker.update(detections, { timestampMs: frameIndex * frameMs, frameIndex });
    }
    tracker.flush();

    const finalized = tracker.takeFinalizedTracks();
    expect(finalized.length).toBeGreaterThan(5);
    expect(finalized.length).toBeLessThan(rawDetections / 3);

    const levels = new Set(finalized.map((track) => severity.calculate(track).level));
    expect(levels.has("small")).toBe(true);
    expect(levels.has("medium")).toBe(true);
    expect(levels.has("large")).toBe(true);
    expect(levels.has("unknown")).toBe(false);

    finalized.forEach((track) => {
      expect(track.observations.length).toBeGreaterThanOrEqual(config.tracking.minObservations);
      expect(track.maxConfidence).toBeGreaterThanOrEqual(config.tracking.minMaxConfidence);
      expect(track.state).toBe("FINALIZED");
    });
  });
});
