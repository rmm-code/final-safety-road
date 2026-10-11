import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatLatency, formatPercent, formatTimecode } from "./format";

describe("timecodes", () => {
  it.each([
    [0, "00:00"],
    [4.2, "00:04"],
    [64, "01:04"],
    [3599, "59:59"],
  ])("formats %ss as %s", (seconds, expected) => {
    expect(formatTimecode(seconds)).toBe(expected);
  });

  it("degrades safely on invalid input", () => {
    expect(formatTimecode(Number.NaN)).toBe("00:00");
    expect(formatTimecode(-5)).toBe("00:00");
  });
});

describe("percentages", () => {
  it("rounds to whole percent by default", () => {
    expect(formatPercent(0.914)).toBe("91%");
  });

  it("supports extra precision", () => {
    expect(formatPercent(0.9146, 1)).toBe("91.5%");
  });

  it("marks a missing value rather than printing NaN", () => {
    expect(formatPercent(Number.NaN)).toBe("-");
  });
});

describe("latency", () => {
  it("reports a bound instead of a misleading zero", () => {
    expect(formatLatency(0.004)).toBe("<0.1 ms");
  });

  it("reports a real measurement to one decimal", () => {
    expect(formatLatency(12.34)).toBe("12.3 ms");
  });

  it("prints a genuine zero as zero", () => {
    expect(formatLatency(0)).toBe("0.0 ms");
  });
});

describe("durations and sizes", () => {
  it.each([
    [0, "0s"],
    [4.2, "4.2s"],
    [42, "42s"],
    [125, "02:05"],
  ])("formats %ss as %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it.each([
    [0, "0 B"],
    [512, "512 B"],
    [37633890, "35.9 MB"],
  ])("formats %s bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
