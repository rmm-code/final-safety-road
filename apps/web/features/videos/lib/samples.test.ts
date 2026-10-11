import { describe, expect, it } from "vitest";
import { analysisId } from "./analysis-id";
import { DEFAULT_SAMPLE_ID, SAMPLES, SAMPLE_SETUP, findSample, sampleOf } from "./samples";

describe("the sample videos", () => {
  it("find their published analysis under the id ai/samples saves it with", async () => {
    // The same value ai/tests/test_samples.py checks on the Python side.
    expect(await analysisId("demo:video-2", SAMPLE_SETUP)).toBe("4d22bf79-4764-8ade-8328-d4d1bcddb0ac");
  });

  it("carry that id precomputed, because a plain-HTTP origin has no crypto.subtle to derive it", async () => {
    for (const sample of SAMPLES) {
      expect(sample.analysisId, sample.id).toBe(await analysisId(`demo:${sample.id}`, SAMPLE_SETUP));
    }
  });

  it("open the default sample for an unknown or missing id", () => {
    expect(findSample("video-3").id).toBe("video-3");
    expect(findSample("nope").id).toBe(DEFAULT_SAMPLE_ID);
    expect(findSample(null).id).toBe(DEFAULT_SAMPLE_ID);
  });

  it("are recognised by poster path, and an upload is not a sample", () => {
    expect(sampleOf("/demo/video-4.jpg")?.id).toBe("video-4");
    expect(sampleOf("http://localhost:9000/pothole-evidence/videos/x/poster.jpg")).toBeUndefined();
    expect(sampleOf(null)).toBeUndefined();
  });
});
