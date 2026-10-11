import { describe, expect, it } from "vitest";
import { analysisId } from "./analysis-id";

const settings = { modelVersion: "pothole-road-anomaly-1.0.0", confidenceThreshold: 0.35, sampleFps: 12 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the id an analysis is saved under", () => {
  it("is a UUID", async () => {
    expect(await analysisId("demo:video-2", settings)).toMatch(UUID);
  });

  it("is the same for the same video at the same settings, so a re-run updates one record", async () => {
    expect(await analysisId("demo:video-2", settings)).toBe(await analysisId("demo:video-2", settings));
  });

  it("changes when the video or any setting changes", async () => {
    const base = await analysisId("demo:video-2", settings);

    expect(await analysisId("demo:video-3", settings)).not.toBe(base);
    expect(await analysisId("demo:video-2", { ...settings, confidenceThreshold: 0.25 })).not.toBe(base);
    expect(await analysisId("demo:video-2", { ...settings, modelVersion: "other-1.0.0" })).not.toBe(base);
    expect(await analysisId("demo:video-2", { ...settings, sampleFps: 6 })).not.toBe(base);
  });
});
