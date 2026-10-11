/**
 * Geometry primitives shared by the vision pipeline.
 *
 * IMPORTANT: every bounding box that crosses a module boundary in this system is
 * expressed in NORMALISED source-frame coordinates (0..1), with the origin at the
 * top-left of the frame. Normalised coordinates keep tracking, severity and overlay
 * rendering independent of camera resolution, video resolution and model input size.
 * Convert to pixels only at the last moment, inside rendering code.
 */
export type BoundingBox = {
  /** Left edge, 0..1 of frame width. */
  x: number;
  /** Top edge, 0..1 of frame height. */
  y: number;
  /** Width, 0..1 of frame width. */
  width: number;
  /** Height, 0..1 of frame height. */
  height: number;
};

/** A point in normalised source-frame coordinates. */
export type NormalisedPoint = readonly [x: number, y: number];

/** Pixel dimensions of a concrete frame. */
export type FrameSize = {
  width: number;
  height: number;
};
