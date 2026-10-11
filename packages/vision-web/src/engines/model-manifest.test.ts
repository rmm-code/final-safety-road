import { describe, expect, it } from "vitest";
import { modelVersionOf, parseModelManifest, resolveModelFileUrl } from "./model-manifest";

const VALID = {
  name: "pothole-detector",
  version: "0.1.0",
  file: "pothole-detector-0.1.0.onnx",
  inputSize: 640,
  classNames: ["pothole"],
};

describe("model manifest validation", () => {
  it("accepts a minimal valid manifest", () => {
    expect(parseModelManifest(VALID)).toEqual(VALID);
  });

  it("keeps optional per-model overrides", () => {
    const manifest = parseModelManifest({
      ...VALID,
      outputLayout: "channels-last",
      confidenceThreshold: 0.5,
    });
    expect(manifest.outputLayout).toBe("channels-last");
    expect(manifest.confidenceThreshold).toBe(0.5);
  });

  it("omits overrides that were not supplied", () => {
    const manifest = parseModelManifest(VALID);
    expect("confidenceThreshold" in manifest).toBe(false);
    expect("outputLayout" in manifest).toBe(false);
  });

  it.each([
    ["a non-object", 42],
    ["a missing name", { ...VALID, name: undefined }],
    ["an empty version", { ...VALID, version: "" }],
    ["a missing file", { ...VALID, file: undefined }],
    ["a zero input size", { ...VALID, inputSize: 0 }],
    ["no classes", { ...VALID, classNames: [] }],
    ["classes without pothole", { ...VALID, classNames: ["crack"] }],
    ["an unknown output layout", { ...VALID, outputLayout: "nchw" }],
    ["an out-of-range threshold", { ...VALID, confidenceThreshold: 1.5 }],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseModelManifest(raw)).toThrow(/Invalid model manifest/);
  });
});

describe("segmentation manifests", () => {
  const SEG = {
    ...VALID,
    task: "segment",
    outputLayout: "channels-first",
    maskCoefficients: 32,
  };

  it("accepts the manifest the export tool writes for a -seg model", () => {
    const manifest = parseModelManifest(SEG);
    expect(manifest.task).toBe("segment");
    expect(manifest.maskCoefficients).toBe(32);
  });

  it("refuses a segmentation model that does not declare its mask channels", () => {
    // Without the count, [1, 37, 8400] is indistinguishable from a 33-class detector and
    // every class score would be read from the wrong offset.
    expect(() => parseModelManifest({ ...SEG, maskCoefficients: undefined })).toThrow(
      /must declare "maskCoefficients"/,
    );
  });

  it("rejects a nonsensical mask channel count", () => {
    expect(() => parseModelManifest({ ...SEG, maskCoefficients: -1 })).toThrow(
      /non-negative integer/,
    );
  });

  it("rejects an unknown task", () => {
    expect(() => parseModelManifest({ ...VALID, task: "pose" })).toThrow(/"task" must be one of/);
  });

  it("accepts the end-to-end layout YOLO26 exports", () => {
    expect(parseModelManifest({ ...VALID, outputLayout: "end-to-end" }).outputLayout).toBe(
      "end-to-end",
    );
  });
});

describe("model identity and file resolution", () => {
  it("builds the model version recorded on every event", () => {
    expect(modelVersionOf(parseModelManifest(VALID))).toBe("pothole-detector-0.1.0");
  });

  it("resolves a relative weights path against the manifest location", () => {
    expect(resolveModelFileUrl("/models/model.json", parseModelManifest(VALID))).toBe(
      "/models/pothole-detector-0.1.0.onnx",
    );
  });

  it("leaves absolute weights URLs untouched", () => {
    const manifest = parseModelManifest({ ...VALID, file: "https://cdn.example/model.onnx" });
    expect(resolveModelFileUrl("/models/model.json", manifest)).toBe(
      "https://cdn.example/model.onnx",
    );
  });
});
