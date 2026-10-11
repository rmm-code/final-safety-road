import { describe, expect, it } from "vitest";
import type { Detection } from "@pothole/shared-types";
import { DEFAULT_VISION_CONFIG, resolveVisionConfig } from "../config/vision-config";
import { TrackManager } from "./track-manager";

/**
 * Frame interval used by these tests, stated explicitly rather than derived from
 * `analysis.sampleFps`.
 *
 * These test the tracker, not the sampling policy, and borrowing the sample rate coupled
 * them to a value they do not care about. It also hid a real interaction worth stating:
 * `minDurationMs` is wall-clock, so the number of sightings needed to satisfy it depends
 * on the rate. At 6 FPS three sightings span 333 ms and clear the 200 ms minimum; at
 * 12 FPS they span only 167 ms and a fourth is required. That is the intended behaviour -
 * the rule rejects momentary flickers, and a flicker is measured in time, not frames.
 */
const FRAME_MS = 1000 / 6;

function detection(y: number, options?: Partial<Detection> & { x?: number; height?: number; width?: number }): Detection {
  return {
    classId: 0,
    className: "pothole",
    confidence: options?.confidence ?? 0.9,
    bbox: {
      x: options?.x ?? 0.45,
      y,
      width: options?.width ?? 0.1,
      height: options?.height ?? 0.08,
    },
  };
}

/** Move a detection sideways, keeping everything else identical. */
function shift(source: Detection, dx: number): Detection {
  return { ...source, bbox: { ...source.bbox, x: source.bbox.x + dx } };
}

/** Feed a sequence of per-frame detection lists, one entry per analysed frame. */
function run(manager: TrackManager, frames: Detection[][], startFrame = 0): void {
  frames.forEach((detections, index) => {
    manager.update(detections, {
      timestampMs: (startFrame + index) * FRAME_MS,
      frameIndex: startFrame + index,
    });
  });
}

describe("TrackManager association", () => {
  it("collapses one pothole seen in many frames into a single track", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [
      [detection(0.4)],
      [detection(0.42)],
      [detection(0.44)],
      [detection(0.46)],
      [detection(0.48)],
    ]);

    expect(manager.activeTracks).toHaveLength(1);
    expect(manager.activeTracks[0]!.observations).toHaveLength(5);
    expect(manager.activeTracks[0]!.state).toBe("CONFIRMED");
  });

  it("keeps two potholes in different lanes apart", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [
      [detection(0.4, { x: 0.15 }), detection(0.4, { x: 0.7 })],
      [detection(0.42, { x: 0.15 }), detection(0.42, { x: 0.7 })],
      [detection(0.44, { x: 0.15 }), detection(0.44, { x: 0.7 })],
    ]);

    expect(manager.activeTracks).toHaveLength(2);
    manager.activeTracks.forEach((track) => expect(track.observations).toHaveLength(3));
  });

  it("assigns each detection to at most one track", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    // Two heavily overlapping detections in one frame must not both land on one track.
    run(manager, [[detection(0.4)], [detection(0.42), detection(0.425)]]);

    const total = manager.activeTracks.reduce((sum, t) => sum + t.observations.length, 0);
    expect(total).toBe(3);
    expect(manager.activeTracks).toHaveLength(2);
  });

  it("survives a frame in which the detector misses the pothole", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [[detection(0.4)], [detection(0.42)], [], [detection(0.46)], [detection(0.48)]]);

    expect(manager.activeTracks).toHaveLength(1);
    expect(manager.activeTracks[0]!.observations).toHaveLength(4);
  });

  it("closes a track once it has been missing for longer than the tolerance", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    const blank = Array.from({ length: DEFAULT_VISION_CONFIG.tracking.maxMissedFrames + 1 }, () => []);
    run(manager, [[detection(0.4)], [detection(0.42)], [detection(0.44)], ...blank]);

    expect(manager.activeTracks).toHaveLength(0);
    expect(manager.takeFinalizedTracks()).toHaveLength(1);
  });

  it("ignores detections below the configured confidence threshold", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [[detection(0.4, { confidence: 0.2 })], [detection(0.42, { confidence: 0.1 })]]);
    expect(manager.activeTracks).toHaveLength(0);
  });
});

describe("TrackManager motion prediction", () => {
  // A pothole accelerates down the frame as the vehicle approaches it. Between two
  // analysed frames it can move further than its own height, at which point raw IoU
  // fails and one pothole would be counted several times.
  const accelerating: Detection[][] = [[detection(0.4)], [detection(0.44)], [detection(0.52)]];

  it("bridges a fast downward jump using the track's own velocity", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, accelerating);
    expect(manager.activeTracks).toHaveLength(1);
    expect(manager.activeTracks[0]!.observations).toHaveLength(3);
  });

  it("splits the same sequence into two tracks when prediction is disabled", () => {
    const manager = new TrackManager(resolveVisionConfig({ tracking: { motionPrediction: false } }));
    run(manager, accelerating);
    expect(manager.activeTracks).toHaveLength(2);
  });
});

describe("TrackManager state machine", () => {
  it("walks CANDIDATE -> TRACKING -> CONFIRMED -> FINALIZED", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);

    manager.update([detection(0.4)], { timestampMs: 0, frameIndex: 0 });
    expect(manager.activeTracks[0]!.state).toBe("CANDIDATE");

    manager.update([detection(0.42)], { timestampMs: FRAME_MS, frameIndex: 1 });
    expect(manager.activeTracks[0]!.state).toBe("TRACKING");

    manager.update([detection(0.44)], { timestampMs: FRAME_MS * 2, frameIndex: 2 });
    expect(manager.activeTracks[0]!.state).toBe("CONFIRMED");

    const finalized = manager.flush();
    expect(finalized[0]!.state).toBe("FINALIZED");
    expect(finalized[0]!.finalized).toBe(true);
    expect(manager.takeFinalizedTracks()).toHaveLength(1);
    expect(manager.takeRejectedTracks()).toHaveLength(0);
  });

  it("rejects a track with too few observations", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [[detection(0.4)], [detection(0.42)]]);
    manager.flush();

    expect(manager.takeFinalizedTracks()).toHaveLength(0);
    const rejected = manager.takeRejectedTracks();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.state).toBe("REJECTED_LOW_CONFIDENCE");
  });

  it("rejects a persistent track whose peak confidence never clears the bar", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [
      [detection(0.4, { confidence: 0.4 })],
      [detection(0.42, { confidence: 0.45 })],
      [detection(0.44, { confidence: 0.5 })],
      [detection(0.46, { confidence: 0.42 })],
    ]);
    manager.flush();

    expect(manager.takeFinalizedTracks()).toHaveLength(0);
    expect(manager.takeRejectedTracks()).toHaveLength(1);
  });

  it("rejects a track that never lasts the minimum duration", () => {
    // Three observations in the same instant: enough sightings, no persistence.
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    [0, 1, 2].forEach((frameIndex) => {
      manager.update([detection(0.4)], { timestampMs: 0, frameIndex });
    });
    manager.flush();

    expect(manager.takeFinalizedTracks()).toHaveLength(0);
    expect(manager.takeRejectedTracks()).toHaveLength(1);
  });

  it("drains finalised tracks exactly once", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [[detection(0.4)], [detection(0.42)], [detection(0.44)]]);
    manager.flush();

    expect(manager.takeFinalizedTracks()).toHaveLength(1);
    expect(manager.takeFinalizedTracks()).toHaveLength(0);
  });

  it("records peak confidence, peak area and trigger-region entry", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [
      [detection(0.55, { confidence: 0.7, width: 0.2, height: 0.15 })],
      [detection(0.62, { confidence: 0.95, width: 0.2, height: 0.15 })],
      [detection(0.7, { confidence: 0.8, width: 0.2, height: 0.15 })],
    ]);

    const track = manager.activeTracks[0]!;
    expect(track.maxConfidence).toBeCloseTo(0.95, 10);
    expect(track.maxArea).toBeCloseTo(0.03, 10);
    expect(track.observations.map((o) => o.inTriggerRegion)).toEqual([false, false, true]);
  });

  it("issues stable sequential identifiers", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [[detection(0.4, { x: 0.1 }), detection(0.4, { x: 0.8 })]]);
    expect(manager.activeTracks.map((t) => t.localTrackId)).toEqual(["track-001", "track-002"]);
  });
});

describe("TrackManager under perspective motion", () => {
  /**
   * A pothole on the road plane, projected the way a windshield-mounted phone sees it:
   * it barely moves near the horizon, then accelerates down the image and grows fast.
   * The close-range observations are the ones severity depends on, so losing them is
   * worse than losing the distant ones.
   */
  function approachSequence(widthM: number, speedMps: number): Detection[][] {
    const frames: Detection[][] = [];
    const fps = DEFAULT_VISION_CONFIG.analysis.sampleFps;
    for (let distance = 40; distance > 3; distance -= speedMps / fps) {
      const width = widthM / (1.4 * distance);
      const height = width * 0.6;
      const centreY = 0.5 + 1.5 / distance;
      frames.push([
        {
          classId: 0,
          className: "pothole",
          confidence: 0.9,
          bbox: { x: 0.5 - width / 2, y: centreY - height / 2, width, height },
        },
      ]);
    }
    return frames;
  }

  it("follows one pothole from the horizon to the bottom of the frame", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    const frames = approachSequence(0.9, 14);
    run(manager, frames);

    expect(manager.activeTracks).toHaveLength(1);
    const track = manager.activeTracks[0]!;
    expect(track.observations).toHaveLength(frames.length);
    expect(track.observations.some((o) => o.inTriggerRegion)).toBe(true);
  });

  it("keeps the largest close-range observation on the confirmed track", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    const frames = approachSequence(0.9, 14);
    run(manager, frames);
    manager.flush();

    const finalized = manager.takeFinalizedTracks();
    expect(finalized).toHaveLength(1);
    const lastFrameArea = (() => {
      const box = frames[frames.length - 1]![0]!.bbox;
      return box.width * box.height;
    })();
    // Severity reads the peak area; if the tail of the track broke away it would be
    // measured from far too far back and every pothole would look small.
    expect(finalized[0]!.maxArea).toBeCloseTo(lastFrameArea, 10);
  });

  it("bridges a dropped frame at any point in the approach", () => {
    const template = approachSequence(0.9, 14);
    // Close to the vehicle the pothole moves further than its own height between
    // frames, so a dropout there used to split the track and lose the largest, most
    // informative observations.
    for (let dropped = 0; dropped < template.length; dropped += 1) {
      const manager = new TrackManager(DEFAULT_VISION_CONFIG);
      run(
        manager,
        template.map((frame, index) => (index === dropped ? [] : frame)),
      );
      manager.flush();
      expect({
        dropped,
        tracks: manager.takeFinalizedTracks().length + manager.takeRejectedTracks().length,
      }).toEqual({ dropped, tracks: 1 });
    }
  });

  it("does not merge two potholes that are genuinely side by side", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    const template = approachSequence(0.6, 12);
    const frames = template.map((frame) => [
      shift(frame[0]!, -0.16),
      shift(frame[0]!, 0.16),
    ]);
    run(manager, frames);

    expect(manager.activeTracks).toHaveLength(2);
    manager.activeTracks.forEach((track) =>
      expect(track.observations).toHaveLength(frames.length),
    );
  });

  it("does not attach a detection that is far from the prediction", () => {
    const manager = new TrackManager(DEFAULT_VISION_CONFIG);
    run(manager, [
      [detection(0.4, { x: 0.2 })],
      [detection(0.42, { x: 0.2 })],
      [detection(0.44, { x: 0.2 }), detection(0.44, { x: 0.85 })],
    ]);

    expect(manager.activeTracks).toHaveLength(2);
    expect(manager.activeTracks[0]!.observations).toHaveLength(3);
    expect(manager.activeTracks[1]!.observations).toHaveLength(1);
  });
});
