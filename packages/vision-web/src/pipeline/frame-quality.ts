import { clamp01 } from "./scores";

/** Minimal shape of a canvas ImageData, so this module stays testable outside a browser. */
export type GrayscaleSource = {
  /** RGBA bytes, four per pixel. */
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
};

/**
 * Variance of the Laplacian, the standard cheap sharpness measure. A blurred crop
 * has little high-frequency energy and therefore a low variance.
 *
 * Returns the raw variance; call `sharpnessScore` for a bounded 0..1 value.
 */
export function laplacianVariance(source: GrayscaleSource): number {
  const { data, width, height } = source;
  if (width < 3 || height < 3) return 0;

  const luminanceAt = (x: number, y: number): number => {
    const index = (y * width + x) * 4;
    const r = Number(data[index] ?? 0);
    const g = Number(data[index + 1] ?? 0);
    const b = Number(data[index + 2] ?? 0);
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  let sum = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const value =
        4 * luminanceAt(x, y) -
        luminanceAt(x - 1, y) -
        luminanceAt(x + 1, y) -
        luminanceAt(x, y - 1) -
        luminanceAt(x, y + 1);
      sum += value;
      sumSquares += value * value;
      count += 1;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return Math.max(0, sumSquares / count - mean * mean);
}

/**
 * Map a Laplacian variance onto 0..1 with a saturating curve, so that "sharp enough"
 * frames are not endlessly out-competed by marginally sharper ones.
 */
export function sharpnessScore(variance: number, halfSaturation: number): number {
  if (halfSaturation <= 0) return 1;
  return clamp01(variance / (variance + halfSaturation));
}
