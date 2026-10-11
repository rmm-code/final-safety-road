import { describe, expect, it } from "vitest";
import { computeLetterbox } from "./letterbox";
import { decodeDetections, resolveLayout, type RawTensor } from "./decode";

const transform = computeLetterbox(1280, 720, 640, 640);

const BASE_OPTIONS = {
  classNames: ["pothole"],
  confidenceThreshold: 0.5,
  nmsIouThreshold: 0.45,
  maxDetections: 10,
  transform,
} as const;

/**
 * Build a synthetic Ultralytics-style detection head. No trained weights exist in the
 * repository, so post-processing is verified against hand-built tensors: this is what
 * catches a transposed layout or a forgotten letterbox offset.
 */
function channelsFirst(rows: number[][], numClasses = 1): RawTensor {
  const channels = 4 + numClasses;
  const anchors = rows.length;
  const data = new Float32Array(channels * anchors);
  rows.forEach((row, anchor) => {
    for (let c = 0; c < channels; c += 1) data[c * anchors + anchor] = row[c] as number;
  });
  return { data, dims: [1, channels, anchors] };
}

function channelsLast(rows: number[][], numClasses = 1): RawTensor {
  const channels = 4 + numClasses;
  const data = new Float32Array(channels * rows.length);
  rows.forEach((row, anchor) => {
    for (let c = 0; c < channels; c += 1) data[anchor * channels + c] = row[c] as number;
  });
  return { data, dims: [1, rows.length, channels] };
}

describe("detector output layout", () => {
  it("detects the Ultralytics channels-first head", () => {
    expect(resolveLayout([1, 5, 8400], 1)).toEqual({
      layout: "channels-first",
      numAnchors: 8400,
      channels: 5,
    });
  });

  it("detects a transposed head", () => {
    expect(resolveLayout([1, 8400, 5], 1)).toEqual({
      layout: "channels-last",
      numAnchors: 8400,
      channels: 5,
    });
  });

  it("prefers the Ultralytics default when the shape is ambiguous", () => {
    expect(resolveLayout([1, 5, 5], 1).layout).toBe("channels-first");
  });

  it("honours an explicitly declared layout", () => {
    expect(resolveLayout([1, 5, 5], 1, "channels-last").layout).toBe("channels-last");
  });

  it("rejects a shape that matches no supported head", () => {
    expect(() => resolveLayout([1, 7, 9], 1)).toThrow(/no axis of size 5/);
  });

  it("rejects a declared layout that does not match the tensor", () => {
    expect(() => resolveLayout([1, 8400, 5], 1, "channels-first")).toThrow(/not channels-first/);
  });
});

describe("decodeDetections", () => {
  it("decodes a box and undoes the letterbox padding", () => {
    const detections = decodeDetections(channelsFirst([[320, 320, 64, 32, 0.9]]), BASE_OPTIONS);
    expect(detections).toHaveLength(1);
    const detection = detections[0]!;
    expect(detection.className).toBe("pothole");
    expect(detection.confidence).toBeCloseTo(0.9, 6);
    expect(detection.bbox.x).toBeCloseTo(0.45, 6);
    expect(detection.bbox.y).toBeCloseTo(328 / 720, 6);
    expect(detection.bbox.width).toBeCloseTo(0.1, 6);
  });

  it("produces identical results for both tensor layouts", () => {
    const rows = [
      [320, 320, 64, 32, 0.9],
      [500, 400, 40, 40, 0.7],
    ];
    expect(decodeDetections(channelsFirst(rows), BASE_OPTIONS)).toEqual(
      decodeDetections(channelsLast(rows), BASE_OPTIONS),
    );
  });

  it("drops detections below the confidence threshold", () => {
    const detections = decodeDetections(
      channelsFirst([
        [320, 320, 64, 32, 0.9],
        [500, 400, 40, 40, 0.2],
      ]),
      BASE_OPTIONS,
    );
    expect(detections).toHaveLength(1);
  });

  it("suppresses duplicate boxes of the same object and keeps the strongest", () => {
    const detections = decodeDetections(
      channelsFirst([
        [320, 320, 64, 32, 0.72],
        [322, 321, 66, 33, 0.94],
        [321, 319, 63, 31, 0.81],
      ]),
      BASE_OPTIONS,
    );
    expect(detections).toHaveLength(1);
    expect(detections[0]!.confidence).toBeCloseTo(0.94, 6);
  });

  it("keeps genuinely separate potholes", () => {
    const detections = decodeDetections(
      channelsFirst([
        [150, 300, 40, 30, 0.8],
        [500, 420, 40, 30, 0.75],
      ]),
      BASE_OPTIONS,
    );
    expect(detections).toHaveLength(2);
  });

  it("honours the maximum detection count", () => {
    const rows = Array.from({ length: 12 }, (_, i) => [40 + i * 45, 300, 30, 20, 0.9]);
    const detections = decodeDetections(channelsFirst(rows), { ...BASE_OPTIONS, maxDetections: 4 });
    expect(detections).toHaveLength(4);
  });

  it("drops classes that are not potholes from a multi-class model", () => {
    // [cx, cy, w, h, potholeScore, crackScore] - the crack wins its anchor.
    const rows = [
      [320, 320, 64, 32, 0.9, 0.1],
      [500, 400, 40, 40, 0.1, 0.95],
    ];
    const detections = decodeDetections(channelsFirst(rows, 2), {
      ...BASE_OPTIONS,
      classNames: ["pothole", "longitudinal_crack"],
    });
    expect(detections).toHaveLength(1);
    expect(detections[0]!.classId).toBe(0);
  });

  it("ignores zero-area anchors", () => {
    expect(decodeDetections(channelsFirst([[320, 320, 0, 0, 0.99]]), BASE_OPTIONS)).toHaveLength(0);
  });
});

/** Segmentation head: class scores followed by mask coefficients. */
function segmentationHead(rows: number[][], numClasses: number, maskCoefficients: number): RawTensor {
  const channels = 4 + numClasses + maskCoefficients;
  const anchors = rows.length;
  const data = new Float32Array(channels * anchors);
  rows.forEach((row, anchor) => {
    for (let c = 0; c < channels; c += 1) data[c * anchors + anchor] = row[c] ?? 0.5;
  });
  return { data, dims: [1, channels, anchors] };
}

/** End-to-end head: x1, y1, x2, y2, confidence, classId - NMS already applied. */
function endToEndHead(rows: number[][]): RawTensor {
  const data = new Float32Array(rows.length * 6);
  rows.forEach((row, index) => {
    for (let c = 0; c < 6; c += 1) data[index * 6 + c] = row[c] as number;
  });
  return { data, dims: [1, rows.length, 6] };
}

describe("segmentation head", () => {
  // The real export of the pothole model is [1, 37, 8400]: 4 box + 1 class + 32 mask
  // coefficients. Reading class scores at the wrong offset would silently mis-detect.
  it("resolves the observed [1, 37, N] shape when mask coefficients are declared", () => {
    expect(resolveLayout([1, 37, 8400], 1, "auto", 32)).toEqual({
      layout: "channels-first",
      numAnchors: 8400,
      channels: 37,
    });
  });

  it("cannot resolve it without the declaration", () => {
    // 4 + 1 + 32 is indistinguishable from a 33-class detector, which is why the count
    // has to come from model.json rather than being guessed.
    expect(() => resolveLayout([1, 37, 8400], 1)).toThrow(/no axis of size 5/);
  });

  it("reads class scores past the box channels and ignores mask coefficients", () => {
    const rows = [[320, 320, 64, 32, 0.9, ...Array.from({ length: 32 }, () => 0.99)]];
    const detections = decodeDetections(segmentationHead(rows, 1, 32), {
      ...BASE_OPTIONS,
      maskCoefficients: 32,
    });

    expect(detections).toHaveLength(1);
    // 0.9 is the class score; the 0.99 mask coefficients must not be mistaken for it.
    expect(detections[0]!.confidence).toBeCloseTo(0.9, 6);
    expect(detections[0]!.bbox.x).toBeCloseTo(0.45, 6);
  });

  it("still applies the confidence threshold to the class score", () => {
    const rows = [[320, 320, 64, 32, 0.2, ...Array.from({ length: 32 }, () => 0.99)]];
    expect(
      decodeDetections(segmentationHead(rows, 1, 32), { ...BASE_OPTIONS, maskCoefficients: 32 }),
    ).toHaveLength(0);
  });
});

describe("end-to-end head", () => {
  it("resolves a [1, n, 6] shape", () => {
    expect(resolveLayout([1, 300, 6], 1)).toEqual({
      layout: "end-to-end",
      numAnchors: 300,
      channels: 6,
    });
  });

  it("decodes corner-form rows without running NMS again", () => {
    // Two heavily overlapping rows: the graph already suppressed duplicates, so both
    // survive. Re-running NMS here would silently drop real detections.
    const detections = decodeDetections(
      endToEndHead([
        [288, 304, 352, 336, 0.9, 0],
        [290, 305, 354, 337, 0.85, 0],
      ]),
      { ...BASE_OPTIONS, layout: "end-to-end" },
    );

    expect(detections).toHaveLength(2);
    expect(detections[0]!.bbox.x).toBeCloseTo(0.45, 6);
    expect(detections[0]!.bbox.width).toBeCloseTo(0.1, 6);
  });

  it("drops padding rows below the threshold", () => {
    const detections = decodeDetections(
      endToEndHead([
        [288, 304, 352, 336, 0.9, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ]),
      { ...BASE_OPTIONS, layout: "end-to-end" },
    );
    expect(detections).toHaveLength(1);
  });

  it("honours the detection limit", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [40 + i * 45, 300, 70 + i * 45, 330, 0.9, 0]);
    expect(
      decodeDetections(endToEndHead(rows), { ...BASE_OPTIONS, layout: "end-to-end", maxDetections: 3 }),
    ).toHaveLength(3);
  });

  it("rejects a mismatched explicit declaration", () => {
    expect(() => resolveLayout([1, 5, 8400], 1, "end-to-end")).toThrow(/not an end-to-end head/);
  });
});

describe("counting classes we do not report", () => {
  const MULTI = {
    ...BASE_OPTIONS,
    classNames: ["Crack", "Crack-Severe", "Pothole", "Speed-Bump"],
  };

  /** [cx, cy, w, h, crack, crackSevere, pothole, speedBump] */
  function multiClass(rows: number[][]): RawTensor {
    return channelsFirst(rows, 4);
  }

  it("reports the classes it skipped, without emitting them as detections", () => {
    const seen: string[] = [];
    const detections = decodeDetections(
      multiClass([
        [320, 320, 64, 32, 0.9, 0.0, 0.0, 0.0],
        [400, 350, 40, 40, 0.0, 0.0, 0.85, 0.0],
        [500, 400, 40, 40, 0.0, 0.0, 0.0, 0.7],
      ]),
      { ...MULTI, onSkippedClass: (name) => seen.push(name) },
    );

    // Only the pothole becomes a detection; the rest are counted and dropped.
    expect(detections).toHaveLength(1);
    expect(detections[0]!.className).toBe("pothole");
    expect(seen.sort()).toEqual(["Crack", "Speed-Bump"]);
  });

  it("does not report classes that fell below the confidence threshold", () => {
    const seen: string[] = [];
    decodeDetections(
      multiClass([[320, 320, 64, 32, 0.1, 0.0, 0.0, 0.0]]),
      { ...MULTI, onSkippedClass: (name) => seen.push(name) },
    );
    // A tally of things the detector was not confident about would be noise.
    expect(seen).toEqual([]);
  });

  it("works without a callback", () => {
    expect(() =>
      decodeDetections(multiClass([[320, 320, 64, 32, 0.9, 0, 0, 0]]), MULTI),
    ).not.toThrow();
  });
});
