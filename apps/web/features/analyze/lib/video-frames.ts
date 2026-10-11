/**
 * Deterministic frame extraction from a video element.
 *
 * Analysis seeks to fixed media times rather than sampling playback. Playback-rate
 * sampling would make results depend on how fast the machine happened to decode, and
 * re-analysing the same file would produce a different report; seeking gives the same
 * frames every time and lets the UI show real progress.
 */

const SEEK_TIMEOUT_MS = 15_000;

export function waitForMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The browser could not decode this video file."));
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

export function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const target = Math.max(0, seconds);

  return new Promise((resolve, reject) => {
    if (
      Math.abs(video.currentTime - target) < 1e-3 &&
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out seeking to ${target.toFixed(2)}s in the video.`));
    }, SEEK_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The browser failed while seeking through this video."));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = target;
  });
}

/** Longest edge of the working canvas. Inference letterboxes to a much smaller tensor. */
export const MAX_FRAME_EDGE = 1280;

export function createFrameCanvas(videoWidth: number, videoHeight: number): HTMLCanvasElement {
  const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(videoWidth, videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(videoWidth * scale));
  canvas.height = Math.max(1, Math.round(videoHeight * scale));
  return canvas;
}

export function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser did not provide a 2D canvas context.");
  return context;
}

export type PixelRect = { x: number; y: number; width: number; height: number };

/** Convert a normalised box into an integer pixel rect clipped to the canvas. */
export function toPixelRect(
  bbox: { x: number; y: number; width: number; height: number },
  canvasWidth: number,
  canvasHeight: number,
  paddingRatio = 0,
): PixelRect {
  const padX = bbox.width * paddingRatio;
  const padY = bbox.height * paddingRatio;
  const left = Math.max(0, Math.floor((bbox.x - padX) * canvasWidth));
  const top = Math.max(0, Math.floor((bbox.y - padY) * canvasHeight));
  const right = Math.min(canvasWidth, Math.ceil((bbox.x + bbox.width + padX) * canvasWidth));
  const bottom = Math.min(canvasHeight, Math.ceil((bbox.y + bbox.height + padY) * canvasHeight));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Encode a region of a frame as a compact image. Returns null when the region is empty. */
export function encodeRegion(
  source: HTMLCanvasElement,
  rect: PixelRect,
  maxEdge: number,
  quality: number,
): string | null {
  if (rect.width < 2 || rect.height < 2) return null;

  const scale = Math.min(1, maxEdge / Math.max(rect.width, rect.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));

  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(
    source,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  // WebP where available; browsers that do not support it fall back to PNG on their own.
  return canvas.toDataURL("image/webp", quality);
}
