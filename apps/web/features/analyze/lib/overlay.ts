import type { SeverityLevel } from "@pothole/shared-types";
import type { SampledFrame } from "./analyse-video";

/**
 * Overlay colours, taken from the severity tokens in DESIGN_SYSTEM.md so a box on the
 * video, a badge in the table and a marker on the map always mean the same thing.
 */
export const SEVERITY_COLOURS: Record<SeverityLevel, string> = {
  small: "#68bf9b",
  medium: "#efb66c",
  large: "#db7979",
  unknown: "#b5b5b5",
};

/** Colour for a detection the pipeline did not associate with a confirmed pothole. */
export const UNTRACKED_COLOUR = "#6b7280";

/**
 * Colour of a confirmed pothole box.
 *
 * Green reads as "the detector found something" at a glance, which is what the box is
 * for. The severity still travels in the label text, and the severity palette continues
 * to carry meaning everywhere it matters for triage - badges, tables and map markers.
 */
export const DETECTION_COLOUR = "#22A06B";

/**
 * Nearest analysed frame to a playback position, or null when the position falls
 * between samples by more than the sampling interval. Returning null matters: drawing a
 * stale box during a gap would suggest the detector saw something it did not.
 */
export function findFrameAt(
  frames: readonly SampledFrame[],
  seconds: number,
  toleranceSeconds: number,
): SampledFrame | null {
  if (frames.length === 0) return null;

  let low = 0;
  let high = frames.length - 1;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const frame = frames[mid] as SampledFrame;
    const distance = Math.abs(frame.seconds - seconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = mid;
    }
    if (frame.seconds < seconds) low = mid + 1;
    else high = mid - 1;
  }

  return bestDistance <= toleranceSeconds ? (frames[bestIndex] as SampledFrame) : null;
}

export type OverlayBox = {
  bbox: { x: number; y: number; width: number; height: number };
  label: string;
  colour: string;
  tracked: boolean;
};

/** Turn one analysed frame into the boxes to paint, given each track's final severity. */
export function buildOverlayBoxes(
  frame: SampledFrame,
  severityByTrack: ReadonlyMap<string, SeverityLevel>,
): OverlayBox[] {
  return frame.detections.map(({ detection, trackId }) => {
    const level = trackId ? severityByTrack.get(trackId) : undefined;
    const confidence = `${Math.round(detection.confidence * 100)}%`;

    if (!trackId) {
      return {
        bbox: detection.bbox,
        label: `Untracked \u00b7 ${confidence}`,
        colour: UNTRACKED_COLOUR,
        tracked: false,
      };
    }
    if (!level) {
      return {
        bbox: detection.bbox,
        label: `Pothole \u00b7 ${confidence}`,
        colour: DETECTION_COLOUR,
        tracked: true,
      };
    }
    return {
      bbox: detection.bbox,
      label: `${level[0]?.toUpperCase()}${level.slice(1)} \u00b7 ${confidence}`,
      colour: DETECTION_COLOUR,
      tracked: true,
    };
  });
}
