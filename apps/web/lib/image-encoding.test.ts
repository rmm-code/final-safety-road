import { describe, expect, it } from "vitest";
import { encodeCanvas, imageContentType } from "./image-encoding";

function canvasReturning(byType: Record<string, string>): HTMLCanvasElement {
  return { toDataURL: (type: string) => byType[type] ?? "data:image/png;base64,PNG" } as never;
}

describe("imageContentType", () => {
  it("reads the type a data URL really holds", () => {
    expect(imageContentType("data:image/webp;base64,AA")).toBe("image/webp");
    expect(imageContentType("data:image/jpeg;base64,AA")).toBe("image/jpeg");
    expect(imageContentType("data:image/png;base64,AA")).toBe("image/png");
  });

  it("does not invent a type for anything else", () => {
    expect(imageContentType("data:video/mp4;base64,AA")).toBeUndefined();
    expect(imageContentType("not a data url")).toBeUndefined();
  });
});

describe("encodeCanvas", () => {
  it("keeps WebP where the browser can encode it", () => {
    const canvas = canvasReturning({ "image/webp": "data:image/webp;base64,W" });
    expect(encodeCanvas(canvas, 0.8)).toBe("data:image/webp;base64,W");
  });

  it("falls back to JPEG when asking for WebP returns a PNG", () => {
    // What a browser without a WebP encoder does: honours the call, ignores the type.
    const canvas = canvasReturning({ "image/jpeg": "data:image/jpeg;base64,J" });
    expect(encodeCanvas(canvas, 0.8)).toBe("data:image/jpeg;base64,J");
  });
});
