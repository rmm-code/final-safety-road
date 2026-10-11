import type { BoundingBox } from "@pothole/shared-types";
import { clampBoxToFrame } from "./geometry";

/**
 * Aspect-preserving resize with centred padding, matching the standard YOLO
 * pre-processing. The transform must be inverted before detections leave the engine,
 * otherwise every box is offset by the padding.
 */
export type LetterboxTransform = {
  sourceWidth: number;
  sourceHeight: number;
  inputWidth: number;
  inputHeight: number;
  /** Uniform scale applied to the source image. */
  scale: number;
  /** Horizontal padding added on EACH side, in input pixels. */
  padX: number;
  /** Vertical padding added on EACH side, in input pixels. */
  padY: number;
};

export function computeLetterbox(
  sourceWidth: number,
  sourceHeight: number,
  inputWidth: number,
  inputHeight: number,
): LetterboxTransform {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error(`Invalid source size ${sourceWidth}x${sourceHeight}`);
  }
  const scale = Math.min(inputWidth / sourceWidth, inputHeight / sourceHeight);
  const scaledWidth = sourceWidth * scale;
  const scaledHeight = sourceHeight * scale;
  return {
    sourceWidth,
    sourceHeight,
    inputWidth,
    inputHeight,
    scale,
    padX: (inputWidth - scaledWidth) / 2,
    padY: (inputHeight - scaledHeight) / 2,
  };
}

/**
 * Map a centre-form box in model-input pixels back to a normalised source-frame box.
 * Boxes are clamped to the frame: a pothole clipped by the frame edge stays usable,
 * it just loses the invisible part.
 */
export function inputBoxToNormalised(
  centreX: number,
  centreY: number,
  width: number,
  height: number,
  transform: LetterboxTransform,
): BoundingBox {
  const { scale, padX, padY, sourceWidth, sourceHeight } = transform;
  const sourceX = (centreX - width / 2 - padX) / scale;
  const sourceY = (centreY - height / 2 - padY) / scale;
  return clampBoxToFrame({
    x: sourceX / sourceWidth,
    y: sourceY / sourceHeight,
    width: width / scale / sourceWidth,
    height: height / scale / sourceHeight,
  });
}

/**
 * Map a corner-form box in model-input pixels back to a normalised source-frame box.
 * End-to-end heads (YOLO26 by default, or any `nms=True` export) emit `x1,y1,x2,y2`
 * rather than centre form, but the letterbox still has to be undone.
 */
export function inputCornersToNormalised(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  transform: LetterboxTransform,
): BoundingBox {
  const { scale, padX, padY, sourceWidth, sourceHeight } = transform;
  const left = (x1 - padX) / scale;
  const top = (y1 - padY) / scale;
  const right = (x2 - padX) / scale;
  const bottom = (y2 - padY) / scale;
  return clampBoxToFrame({
    x: left / sourceWidth,
    y: top / sourceHeight,
    width: (right - left) / sourceWidth,
    height: (bottom - top) / sourceHeight,
  });
}
