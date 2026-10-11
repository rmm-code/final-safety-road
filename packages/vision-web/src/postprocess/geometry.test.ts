import { describe, expect, it } from "vitest";
import { boxArea, boxCentroid, clampBoxToFrame, iou, translateBox } from "./geometry";

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("bounding-box geometry", () => {
  it("returns 1 for identical boxes", () => {
    expect(iou(box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2))).toBeCloseTo(1, 10);
  });

  it("returns 0 for disjoint boxes", () => {
    expect(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.1, 0.1))).toBe(0);
  });

  it("returns 0 for boxes that only touch at an edge", () => {
    expect(iou(box(0, 0, 0.1, 0.1), box(0.1, 0, 0.1, 0.1))).toBe(0);
  });

  it("computes partial overlap", () => {
    // Two 0.2 squares offset by 0.1 on both axes: intersection 0.01, union 0.07.
    expect(iou(box(0, 0, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2))).toBeCloseTo(0.01 / 0.07, 10);
  });

  it("treats degenerate boxes as non-overlapping instead of producing NaN", () => {
    expect(iou(box(0.1, 0.1, 0, 0), box(0.1, 0.1, 0.2, 0.2))).toBe(0);
  });

  it("clamps boxes that extend past the frame while keeping the visible part", () => {
    const clamped = clampBoxToFrame(box(0.9, -0.1, 0.4, 0.3));
    expect(clamped.x).toBeCloseTo(0.9, 10);
    expect(clamped.y).toBe(0);
    expect(clamped.width).toBeCloseTo(0.1, 10);
    expect(clamped.height).toBeCloseTo(0.2, 10);
  });

  it("reports area and centroid", () => {
    expect(boxArea(box(0.2, 0.2, 0.5, 0.4))).toBeCloseTo(0.2, 10);
    expect(boxCentroid(box(0.2, 0.2, 0.4, 0.4))).toEqual([0.4, 0.4]);
  });

  it("translates without clamping so the tracker can predict off-frame motion", () => {
    expect(translateBox(box(0.4, 0.9, 0.1, 0.2), 0, 0.2)).toEqual({
      x: 0.4,
      y: 1.1,
      width: 0.1,
      height: 0.2,
    });
  });
});
