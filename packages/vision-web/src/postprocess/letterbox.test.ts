import { describe, expect, it } from "vitest";
import { computeLetterbox, inputBoxToNormalised } from "./letterbox";

describe("letterbox transform", () => {
  it("pads the short axis of a landscape frame", () => {
    const t = computeLetterbox(1280, 720, 640, 640);
    expect(t.scale).toBeCloseTo(0.5, 10);
    expect(t.padX).toBeCloseTo(0, 10);
    expect(t.padY).toBeCloseTo(140, 10);
  });

  it("pads the short axis of a portrait frame", () => {
    const t = computeLetterbox(720, 1280, 640, 640);
    expect(t.scale).toBeCloseTo(0.5, 10);
    expect(t.padX).toBeCloseTo(140, 10);
    expect(t.padY).toBeCloseTo(0, 10);
  });

  it("maps a centre-form input box back to normalised source coordinates", () => {
    const t = computeLetterbox(1280, 720, 640, 640);
    // 128x64 source pixels at source (576, 328) once the 140px padding is removed.
    const box = inputBoxToNormalised(320, 320, 64, 32, t);
    expect(box.x).toBeCloseTo(0.45, 10);
    expect(box.y).toBeCloseTo(328 / 720, 10);
    expect(box.width).toBeCloseTo(0.1, 10);
    expect(box.height).toBeCloseTo(64 / 720, 10);
  });

  it("recovers the full frame from a box covering the whole padded image", () => {
    const t = computeLetterbox(1280, 720, 640, 640);
    const box = inputBoxToNormalised(320, 320, 640, 360, t);
    expect(box.x).toBeCloseTo(0, 10);
    expect(box.y).toBeCloseTo(0, 10);
    expect(box.width).toBeCloseTo(1, 10);
    expect(box.height).toBeCloseTo(1, 10);
  });

  it("clips a detection that runs off the frame edge", () => {
    const t = computeLetterbox(1280, 720, 640, 640);
    const box = inputBoxToNormalised(20, 320, 80, 40, t);
    expect(box.x).toBe(0);
    expect(box.width).toBeCloseTo(60 / 0.5 / 1280, 10);
  });

  it("rejects an impossible source size instead of producing NaN boxes", () => {
    expect(() => computeLetterbox(0, 720, 640, 640)).toThrow(/Invalid source size/);
  });
});
