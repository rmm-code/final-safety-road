import type { FrameSize } from "@pothole/shared-types";

/**
 * Intrinsic pixel size of any CanvasImageSource.
 *
 * The CSS size of a <video> is irrelevant: detections must be normalised against the
 * real decoded frame, otherwise every box is stretched by the element's layout.
 */
export function getSourceSize(source: CanvasImageSource): FrameSize {
  const candidate = source as unknown as Record<string, unknown>;

  const pick = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };

  const width = pick("videoWidth", "naturalWidth", "displayWidth", "width");
  const height = pick("videoHeight", "naturalHeight", "displayHeight", "height");

  if (width === undefined || height === undefined) {
    throw new Error("Unable to determine the intrinsic size of the inference source");
  }
  return { width, height };
}
