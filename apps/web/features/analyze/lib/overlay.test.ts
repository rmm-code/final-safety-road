import { describe, expect, it } from "vitest";
import type { SeverityLevel } from "@pothole/shared-types";
import type { SampledFrame } from "./analyse-video";
import { buildOverlayBoxes, DETECTION_COLOUR, findFrameAt, UNTRACKED_COLOUR } from "./overlay";

const bbox = { x: 0.4, y: 0.6, width: 0.1, height: 0.08 };

function frame(seconds: number, entries: { trackId: string | null; confidence: number }[]): SampledFrame {
  return {
    seconds,
    detections: entries.map(({ trackId, confidence }) => ({
      trackId,
      detection: { classId: 0, className: "pothole" as const, confidence, bbox },
    })),
  };
}

const FRAMES: SampledFrame[] = [0, 0.5, 1, 1.5, 2].map((seconds) => frame(seconds, []));

describe("finding the analysed frame for a playback position", () => {
  it("returns the exact sample", () => {
    expect(findFrameAt(FRAMES, 1, 0.25)?.seconds).toBe(1);
  });

  it("snaps to the nearest sample inside the tolerance", () => {
    expect(findFrameAt(FRAMES, 1.1, 0.25)?.seconds).toBe(1);
    expect(findFrameAt(FRAMES, 1.4, 0.25)?.seconds).toBe(1.5);
  });

  it("returns nothing when the position falls in a gap", () => {
    // Drawing a stale box here would claim the detector saw something it never saw.
    expect(findFrameAt([frame(0, []), frame(10, [])], 5, 0.25)).toBeNull();
  });

  it("handles the ends of the range", () => {
    expect(findFrameAt(FRAMES, -1, 0.25)).toBeNull();
    expect(findFrameAt(FRAMES, 2.1, 0.25)?.seconds).toBe(2);
  });

  it("handles an empty analysis", () => {
    expect(findFrameAt([], 1, 0.25)).toBeNull();
  });
});

describe("overlay boxes", () => {
  const severities = new Map<string, SeverityLevel>([["track-001", "large"]]);

  it("draws a confirmed pothole in green", () => {
    const [box] = buildOverlayBoxes(frame(1, [{ trackId: "track-001", confidence: 0.94 }]), severities);
    expect(box!.colour).toBe(DETECTION_COLOUR);
  });

  it("labels a confirmed pothole with its visual severity and confidence", () => {
    const [box] = buildOverlayBoxes(frame(1, [{ trackId: "track-001", confidence: 0.94 }]), severities);
    expect(box!.label).toBe("Large \u00b7 94%");
    expect(box!.colour).toBe(DETECTION_COLOUR);
    expect(box!.tracked).toBe(true);
  });

  it("distinguishes detections the pipeline did not count", () => {
    const [box] = buildOverlayBoxes(frame(1, [{ trackId: null, confidence: 0.41 }]), severities);
    expect(box!.label).toBe("Untracked \u00b7 41%");
    expect(box!.colour).toBe(UNTRACKED_COLOUR);
    expect(box!.tracked).toBe(false);
  });

  it("falls back to a neutral label for a track that was never confirmed", () => {
    const [box] = buildOverlayBoxes(frame(1, [{ trackId: "track-009", confidence: 0.6 }]), severities);
    expect(box!.label).toBe("Pothole \u00b7 60%");
    expect(box!.colour).toBe(DETECTION_COLOUR);
  });
});
