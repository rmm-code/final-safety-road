import { describe, expect, it } from "vitest";
import { healthUrl, safeNextPath } from "./auth";

describe("safeNextPath", () => {
  it("keeps a path on this site", () => {
    expect(safeNextPath("/drive")).toBe("/drive");
    expect(safeNextPath("/potholes/abc?tab=history")).toBe("/potholes/abc?tab=history");
  });

  it("refuses anything that would leave the site", () => {
    // Each of these would make the sign-in page an open redirect to a lookalike.
    expect(safeNextPath("https://evil.example/login")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
  });

  it("falls back to the overview without a target", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });
});

describe("healthUrl", () => {
  it("uses this origin's forwarded path when the API shares it", () => {
    expect(healthUrl("")).toBe("/api/health");
  });

  it("goes to the API's own /health when it lives elsewhere", () => {
    expect(healthUrl("https://api.example.com/")).toBe("https://api.example.com/health");
  });
});
