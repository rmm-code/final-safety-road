import { describe, expect, it, vi } from "vitest";
import type { Detection, VisionEngineInfo } from "@pothole/shared-types";
import {
  DEFAULT_VISION_CONFIG,
  LocationBuffer,
  type DescribedVisionEngine,
} from "@pothole/vision-web";
import { DriveRecorder, type DriveEvent } from "./drive-recorder";

const SOURCE = null as unknown as CanvasImageSource;

const INFO: VisionEngineInfo = {
  kind: "onnx",
  modelVersion: "pothole-detector-0.1.0",
  backend: "webgpu",
  isSynthetic: false,
  selectionReason: "test",
};

/** A controllable engine: scripted detections and controllable inference duration. */
function fakeEngine(script: Detection[][], options?: { latencyMs?: number; clock?: { now: number } }) {
  let call = 0;
  const engine: DescribedVisionEngine & { calls: () => number } = {
    info: INFO,
    stats: { inferenceCount: 0, lastInferenceMs: 0, averageInferenceMs: 0 },
    otherClassCounts: {},
    isBusy: () => false,
    init: async () => {},
    dispose: async () => {},
    calls: () => call,
    infer: async () => {
      const frame = script[Math.min(call, script.length - 1)] ?? [];
      call += 1;
      if (options?.latencyMs && options.clock) options.clock.now += options.latencyMs;
      return frame;
    },
  };
  return engine;
}

function detection(y: number, confidence = 0.9, height = 0.09): Detection {
  return {
    classId: 0,
    className: "pothole",
    confidence,
    bbox: { x: 0.45, y, width: height * 1.6, height },
  };
}

/**
 * A pothole approaching the camera on the road plane: it barely moves near the horizon,
 * then accelerates down the image and grows. Anything coarser than this is not something
 * the tracker is expected to associate.
 */
function approachFrames(): Detection[][] {
  const frames: Detection[][] = [];
  for (let distance = 25; distance > 3.5; distance -= 2.4) {
    const height = (0.9 / (1.4 * distance)) * 0.6;
    const centreY = 0.5 + 1.5 / distance;
    frames.push([detection(centreY - height / 2, 0.9, height)]);
  }
  // Trailing empty frames so the track times out and finalises.
  for (let i = 0; i < 5; i += 1) frames.push([]);
  return frames;
}

function buffer(samples: number[]): LocationBuffer {
  const b = new LocationBuffer();
  samples.forEach((t) =>
    b.add({ timestamp: t, lat: 41.31, lng: 69.28, accuracyM: 8, speedMps: 12, headingDeg: 90 }),
  );
  return b;
}

describe("frame pacing", () => {
  it("skips a frame while inference is still running", async () => {
    const clock = { now: 0 };
    const engine = fakeEngine([[]]);
    let release: (() => void) = () => {};
    engine.infer = () => new Promise<Detection[]>((resolve) => { release = () => resolve([]); });

    const recorder = new DriveRecorder({
      engine,
      config: DEFAULT_VISION_CONFIG,
      locations: buffer([]),
      driveSessionId: "s",
      onEvent: vi.fn(),
      now: () => clock.now,
    });

    const first = recorder.tick(SOURCE);
    clock.now += 1000;
    // A stale frame is worth less than a fresh one, so this must be dropped, not queued.
    expect(await recorder.tick(SOURCE)).toBe(false);
    expect(recorder.stats.framesSkipped).toBe(1);

    release();
    expect(await first).toBe(true);
  });

  it("paces inference to the target rate rather than every animation frame", async () => {
    const clock = { now: 0 };
    const recorder = new DriveRecorder({
      engine: fakeEngine([[]]),
      config: DEFAULT_VISION_CONFIG,
      locations: buffer([]),
      driveSessionId: "s",
      targetFps: 5,
      onEvent: vi.fn(),
      now: () => clock.now,
    });

    expect(await recorder.tick(SOURCE)).toBe(true);
    clock.now += 50; // 20 FPS worth of animation frames
    expect(await recorder.tick(SOURCE)).toBe(false);
    clock.now += 160; // now past the 200 ms budget for 5 FPS
    expect(await recorder.tick(SOURCE)).toBe(true);
    expect(recorder.stats.framesInferred).toBe(2);
  });

  it("reports latency and inference rate", async () => {
    const clock = { now: 0 };
    const recorder = new DriveRecorder({
      engine: fakeEngine([[]], { latencyMs: 40, clock }),
      config: DEFAULT_VISION_CONFIG,
      locations: buffer([]),
      driveSessionId: "s",
      targetFps: 10,
      onEvent: vi.fn(),
      now: () => clock.now,
    });

    for (let i = 0; i < 4; i += 1) {
      await recorder.tick(SOURCE);
      clock.now += 100;
    }
    expect(recorder.stats.lastLatencyMs).toBe(40);
    expect(recorder.stats.inferenceFps).toBeGreaterThan(0);
  });
});

describe("event capture", () => {
  const script = approachFrames();

  function run(locations: LocationBuffer, onEvent: (e: DriveEvent) => void) {
    const clock = { now: 10_000 };
    const recorder = new DriveRecorder({
      engine: fakeEngine(script),
      config: DEFAULT_VISION_CONFIG,
      locations,
      driveSessionId: "session-1",
      targetFps: 6,
      onEvent,
      now: () => clock.now,
      newId: () => "event-1",
    });
    return { recorder, clock };
  }

  it("emits one event for a pothole seen across many frames", async () => {
    const events: DriveEvent[] = [];
    const { recorder, clock } = run(buffer([10_000, 10_500, 11_000]), (e) => events.push(e));

    for (let i = 0; i < script.length; i += 1) {
      await recorder.tick(SOURCE);
      clock.now += 200;
    }
    recorder.finish();

    expect(events).toHaveLength(1);
    expect(events[0]!.build.ok).toBe(true);
    expect(events[0]!.observationCount).toBeGreaterThanOrEqual(
      DEFAULT_VISION_CONFIG.tracking.minObservations,
    );
    expect(recorder.stats.eventsBuilt).toBe(1);
  });

  it("rejects the event when no GPS fix is near the sighting", async () => {
    const events: DriveEvent[] = [];
    const { recorder, clock } = run(buffer([]), (e) => events.push(e));

    for (let i = 0; i < script.length; i += 1) {
      await recorder.tick(SOURCE);
      clock.now += 200;
    }
    recorder.finish();

    expect(events).toHaveLength(1);
    expect(events[0]!.build.ok).toBe(false);
    if (events[0]!.build.ok) return;
    expect(events[0]!.build.reason).toBe("REJECTED_NO_LOCATION");
    expect(recorder.stats.eventsRejected).toBe(1);
  });

  it("attaches the best evidence frame, not the first", async () => {
    const events: DriveEvent[] = [];
    const { recorder, clock } = run(buffer([10_000, 11_000]), (e) => events.push(e));
    const seen: number[] = [];

    for (let i = 0; i < script.length; i += 1) {
      await recorder.tick(SOURCE, (bbox) => {
        seen.push(bbox.y);
        return { cropImage: `crop-${seen.length}` };
      });
      clock.now += 200;
    }
    recorder.finish();

    // The pothole grows as it approaches, so the last and closest sighting should win -
    // never the first, which is a few distant pixels.
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[seen.length - 1]).toBeGreaterThan(seen[0] as number);
    expect(events[0]!.cropImage).toBe(`crop-${seen.length}`);
  });

  it("closes tracks still in view when the drive stops", async () => {
    const events: DriveEvent[] = [];
    const { recorder, clock } = run(buffer([10_000, 11_000]), (e) => events.push(e));

    // Stop while the pothole is still in view, before the track would time out.
    for (let i = 0; i < 5; i += 1) {
      await recorder.tick(SOURCE);
      clock.now += 200;
    }
    expect(events).toHaveLength(0);

    recorder.finish();
    // A pothole visible at the moment the driver parks must not be silently dropped.
    expect(events).toHaveLength(1);
  });

  it("carries the model version onto the event", async () => {
    const events: DriveEvent[] = [];
    const { recorder, clock } = run(buffer([10_000, 11_000]), (e) => events.push(e));
    for (let i = 0; i < script.length; i += 1) {
      await recorder.tick(SOURCE);
      clock.now += 200;
    }
    recorder.finish();
    const build = events[0]!.build;
    expect(build.ok && build.event.modelVersion).toBe("pothole-detector-0.1.0");
  });
});
