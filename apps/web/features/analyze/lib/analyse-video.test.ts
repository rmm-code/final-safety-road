import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Detection, VisionEngineInfo } from "@pothole/shared-types";
import { resolveVisionConfig, type DescribedVisionEngine } from "@pothole/vision-web";
import { analyseVideo } from "./analyse-video";

const INFO: VisionEngineInfo = {
  kind: "onnx",
  modelVersion: "pothole-detector-0.1.0",
  backend: "wasm",
  isSynthetic: false,
  selectionReason: "test",
};

function pothole(confidence: number, x: number): Detection {
  return { classId: 0, className: "pothole", confidence, bbox: { x, y: 0.6, width: 0.1, height: 0.06 } };
}

/** Returns the same potholes on every frame, as a detector decoding below the run's threshold would. */
function fakeEngine(frame: Detection[]): DescribedVisionEngine {
  return {
    info: INFO,
    stats: { inferenceCount: 0, lastInferenceMs: 0, averageInferenceMs: 0 },
    otherClassCounts: {},
    isBusy: () => false,
    init: async () => {},
    dispose: async () => {},
    infer: async () => frame.map((detection) => ({ ...detection, bbox: { ...detection.bbox } })),
  };
}

/** Just enough of a video element: metadata is loaded and every seek lands at once. */
class FakeVideo extends EventTarget {
  readonly readyState = HTMLMediaElement.HAVE_ENOUGH_DATA;
  readonly duration = 1;
  readonly videoWidth = 640;
  readonly videoHeight = 360;
  private time = 0;

  get currentTime(): number {
    return this.time;
  }

  set currentTime(seconds: number) {
    this.time = seconds;
    this.dispatchEvent(new Event("seeked"));
  }
}

async function analyse(threshold: number, frame: Detection[]) {
  return analyseVideo({
    video: new FakeVideo() as unknown as HTMLVideoElement,
    engine: fakeEngine(frame),
    config: resolveVisionConfig({ detection: { confidenceThreshold: threshold }, analysis: { sampleFps: 12 } }),
  });
}

const FRAMES = 12; // 1 s at 12 FPS

describe("analyseVideo at the run's confidence threshold", () => {
  beforeEach(() => {
    // jsdom has no 2D canvas; analysis only draws into it and reads crops back.
    const context = {
      drawImage: () => {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
        width,
        height,
      }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:,");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops detections below it before counting, drawing or tracking them", async () => {
    const result = await analyse(0.35, [pothole(0.1, 0.05), pothole(0.2, 0.4), pothole(0.9, 0.75)]);

    expect(result.rawDetections).toBe(FRAMES);
    expect(result.frames).toHaveLength(FRAMES);
    for (const frame of result.frames) {
      expect(frame.detections.map(({ detection }) => detection.confidence)).toEqual([0.9]);
      expect(frame.detections[0]!.trackId).not.toBeNull();
    }
    expect(result.potholes).toHaveLength(1);
    expect(result.rejectedTracks).toBe(0);
  });

  it("admits what a lower threshold allows, all the way to the tracker", async () => {
    const result = await analyse(0.15, [pothole(0.1, 0.05), pothole(0.2, 0.4), pothole(0.9, 0.75)]);

    expect(result.rawDetections).toBe(FRAMES * 2);
    for (const frame of result.frames) {
      expect(frame.detections.map(({ detection }) => detection.confidence)).toEqual([0.2, 0.9]);
      expect(frame.detections.every(({ trackId }) => trackId !== null)).toBe(true);
    }
  });
});
