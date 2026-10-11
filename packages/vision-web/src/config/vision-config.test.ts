import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_VISION_CONFIG, resolveVisionConfig } from "./vision-config";

const YAML_PATH = fileURLToPath(new URL("../../../../ai/configs/vision.yaml", import.meta.url));

describe("vision configuration", () => {
  it("stays identical to the canonical YAML read by the Python pipeline", () => {
    const yaml = parse(readFileSync(YAML_PATH, "utf8")) as unknown;
    // Drift here means the browser and the Python CLI would score the same footage
    // differently. The YAML is canonical; update the TypeScript mirror to match.
    expect(yaml).toEqual(DEFAULT_VISION_CONFIG);
  });

  it("keeps severity bands ordered and inside the unit interval", () => {
    const { smallMax, mediumMax } = DEFAULT_VISION_CONFIG.severity;
    expect(smallMax).toBeGreaterThan(0);
    expect(smallMax).toBeLessThan(mediumMax);
    expect(mediumMax).toBeLessThan(1);
  });

  it("uses severity confidence weights that sum to one", () => {
    const w = DEFAULT_VISION_CONFIG.severity.confidenceWeights;
    expect(w.base + w.detection + w.persistence + w.triggerRegion).toBeCloseTo(1, 10);
  });

  it("samples video files more often than the live camera", () => {
    // Analysing a file is offline, so it can afford accuracy; the live camera is bounded
    // by what a phone sustains alongside a 30 FPS preview. One value for both would mean
    // tuning either one degrades the other.
    expect(DEFAULT_VISION_CONFIG.analysis.sampleFps).toBeGreaterThan(
      DEFAULT_VISION_CONFIG.drive.targetFps,
    );
  });

  it("keeps the live rate inside the range a phone can sustain", () => {
    expect(DEFAULT_VISION_CONFIG.drive.targetFps).toBeGreaterThanOrEqual(4);
    expect(DEFAULT_VISION_CONFIG.drive.targetFps).toBeLessThanOrEqual(10);
  });

  it("merges overrides without mutating the defaults", () => {
    const overridden = resolveVisionConfig({ severity: { smallMax: 0.4 } });
    expect(overridden.severity.smallMax).toBe(0.4);
    expect(overridden.severity.mediumMax).toBe(DEFAULT_VISION_CONFIG.severity.mediumMax);
    expect(DEFAULT_VISION_CONFIG.severity.smallMax).toBe(0.3);
  });

  it("returns the defaults object when there is nothing to override", () => {
    expect(resolveVisionConfig()).toBe(DEFAULT_VISION_CONFIG);
  });
});
