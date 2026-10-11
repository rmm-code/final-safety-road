import { describe, expect, it } from "vitest";
import type { LocationSample } from "@pothole/shared-types";
import { LocationBuffer } from "./location-buffer";

function sample(timestamp: number, lat = 41.31, lng = 69.28, accuracyM = 8): LocationSample {
  return { timestamp, lat, lng, accuracyM, speedMps: 12, headingDeg: 90 };
}

describe("LocationBuffer", () => {
  it("returns nothing before the first fix arrives", () => {
    const buffer = new LocationBuffer();
    expect(buffer.latest()).toBeNull();
    expect(buffer.nearestTo(1000)).toBeNull();
  });

  it("finds the sample closest to a detection timestamp", () => {
    const buffer = new LocationBuffer();
    [1000, 2000, 3000].forEach((t) => buffer.add(sample(t)));

    expect(buffer.nearestTo(2100)?.timestamp).toBe(2000);
    expect(buffer.nearestTo(2600)?.timestamp).toBe(3000);
    expect(buffer.nearestTo(2000)?.timestamp).toBe(2000);
  });

  it("looks backwards as readily as forwards", () => {
    // A detection finalised between two fixes must take the nearer one, whichever side.
    const buffer = new LocationBuffer();
    [1000, 5000].forEach((t) => buffer.add(sample(t)));
    expect(buffer.nearestTo(1900)?.timestamp).toBe(1000);
    expect(buffer.nearestTo(4200)?.timestamp).toBe(5000);
  });

  it("refuses a sample that is too far away in time", () => {
    // A fix from 30 s away describes a different piece of road; returning it would place
    // the marker hundreds of metres out.
    const buffer = new LocationBuffer();
    buffer.add(sample(1000));
    expect(buffer.nearestTo(40_000)).toBeNull();
    expect(buffer.nearestTo(40_000, 60_000)?.timestamp).toBe(1000);
  });

  it("keeps the newest sample available", () => {
    const buffer = new LocationBuffer();
    [1000, 2000, 3000].forEach((t) => buffer.add(sample(t)));
    expect(buffer.latest()?.timestamp).toBe(3000);
  });

  it("orders a sample that the browser delivered late", () => {
    const buffer = new LocationBuffer();
    [1000, 3000].forEach((t) => buffer.add(sample(t)));
    buffer.add(sample(2000));
    expect(buffer.all.map((s) => s.timestamp)).toEqual([1000, 2000, 3000]);
    expect(buffer.nearestTo(2050)?.timestamp).toBe(2000);
  });

  it("discards samples older than the retention window", () => {
    const buffer = new LocationBuffer({ retentionMs: 10_000 });
    buffer.add(sample(1000));
    buffer.add(sample(5000));
    buffer.add(sample(30_000));
    // A drive lasts an hour; the buffer must not grow for its whole duration.
    expect(buffer.size).toBe(1);
    expect(buffer.all[0]?.timestamp).toBe(30_000);
  });

  it("preserves the accuracy reported with each fix", () => {
    const buffer = new LocationBuffer();
    buffer.add(sample(1000, 41.31, 69.28, 23.5));
    // Accuracy is never assumed; it travels with the event.
    expect(buffer.nearestTo(1000)?.accuracyM).toBe(23.5);
  });

  it("can be reset between drives", () => {
    const buffer = new LocationBuffer();
    buffer.add(sample(1000));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.latest()).toBeNull();
  });
});
