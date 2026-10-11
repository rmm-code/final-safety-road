import { describe, expect, it } from "vitest";
import { modelSources } from "./models";

describe("where a saved analysis's models come from", () => {
  it("names each model of a merge, with a link to its source", () => {
    const sources = modelSources("pothole-road-anomaly-1.0.0+mfranzon-yolo26m-1.0.0+rezzzq-yolo12s-1.0.0");

    expect(sources.map((source) => source.label)).toEqual(["collabdoor YOLOv8m", "mfranzon YOLO26m", "rezzzq YOLO12s"]);
    expect(sources.every((source) => source.url?.startsWith("https://"))).toBe(true);
  });

  it("keeps an unknown model as its version, without a link", () => {
    expect(modelSources("pothole-road-anomaly-2.0.0")[0]?.label).toBe("collabdoor YOLOv8m");
    expect(modelSources("finetuned-tashkent-0.1.0")).toEqual([{ label: "finetuned-tashkent-0.1.0", url: null }]);
  });
});
