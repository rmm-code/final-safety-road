import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveVisionConfig } from "../config/vision-config";
import type { RawTensor } from "../postprocess/decode";
import { createVisionEngine } from "./factory";

const INPUT = 64;
const THRESHOLD = 0.35;
const SOURCE = { width: INPUT, height: INPUT } as unknown as CanvasImageSource;

/** The raw output the fake session returns, swapped per test. */
const session = vi.hoisted(() => ({ output: null as RawTensor | null }));

vi.mock("onnxruntime-web", () => ({
  env: { wasm: {} },
  InferenceSession: {
    create: async () => ({
      inputNames: ["images"],
      outputNames: ["output0"],
      run: async () => ({ output0: session.output }),
    }),
  },
  Tensor: class {
    constructor(
      readonly type: string,
      readonly data: Float32Array,
      readonly dims: number[],
    ) {}
  },
}));

/** Node has no canvas; preprocessing only needs pixels to exist. */
class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}

  getContext() {
    return {
      fillStyle: "",
      fillRect: () => {},
      drawImage: () => {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
    };
  }
}

/** Channels-first head over [cx, cy, w, h, crack, pothole] rows, in model-input pixels. */
function head(rows: number[][]): RawTensor {
  const channels = 6;
  const data = new Float32Array(channels * rows.length);
  rows.forEach((row, anchor) => {
    for (let c = 0; c < channels; c += 1) data[c * rows.length + anchor] = row[c] as number;
  });
  return { data, dims: [1, channels, rows.length] };
}

async function engineWith(options: { confidenceFloor?: number; manifestThreshold?: number } = {}) {
  const manifest = {
    name: "test-model",
    version: "1.0.0",
    file: "test-model.onnx",
    inputSize: INPUT,
    classNames: ["Crack", "Pothole"],
    outputLayout: "channels-first",
    ...(options.manifestThreshold === undefined ? {} : { confidenceThreshold: options.manifestThreshold }),
  };
  return createVisionEngine({
    mode: "onnx",
    config: resolveVisionConfig({ detection: { confidenceThreshold: THRESHOLD } }),
    manifestUrl: "/models/model.json",
    fetchImpl: (async () => Response.json(manifest)) as unknown as typeof fetch,
    ...(options.confidenceFloor === undefined ? {} : { confidenceFloor: options.confidenceFloor }),
  });
}

describe("ONNX engine confidence floor", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    session.output = head([
      [16, 16, 8, 8, 0.0, 0.2], // a weak pothole
      [44, 16, 8, 8, 0.2, 0.0], // a weak crack
      [16, 44, 8, 8, 0.5, 0.0], // a confident crack
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("without a floor, decodes and counts other classes at the configured threshold", async () => {
    const engine = await engineWith();

    expect(await engine.infer(SOURCE)).toEqual([]);
    expect(engine.otherClassCounts).toEqual({ Crack: 1 });
  });

  it("with a floor, also returns weaker potholes, but still counts only confident other classes", async () => {
    const engine = await engineWith({ confidenceFloor: 0.05 });

    const detections = await engine.infer(SOURCE);
    expect(detections).toHaveLength(1);
    expect(detections[0]!.confidence).toBeCloseTo(0.2, 6);
    expect(engine.otherClassCounts).toEqual({ Crack: 1 });
  });

  it("lowers a threshold the manifest sets, too", async () => {
    const engine = await engineWith({ confidenceFloor: 0.05, manifestThreshold: 0.3 });

    expect(await engine.infer(SOURCE)).toHaveLength(1);
    expect(engine.otherClassCounts).toEqual({ Crack: 1 });
  });
});
