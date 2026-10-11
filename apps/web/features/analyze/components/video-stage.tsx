"use client";

import { useEffect, useRef } from "react";
import type { SeverityLevel } from "@pothole/shared-types";
import type { SampledFrame } from "../lib/analyse-video";
import { buildOverlayBoxes, findFrameAt } from "../lib/overlay";

type VideoStageProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoUrl: string;
  frames: readonly SampledFrame[];
  severityByTrack: ReadonlyMap<string, SeverityLevel>;
  /** Half the sampling interval: how far a playback position may be from a sample. */
  toleranceSeconds: number;
  triggerRegionTopY: number;
  aspectRatio: number | null;
  controls: boolean;
  onLoadedMetadata?: () => void;
};

/**
 * Ceiling on the preview's height.
 *
 * The stage carries the video's own aspect ratio, and most road footage is shot on a
 * phone, so an unbounded stage is as tall as the column is wide: a 9:16 clip in an 800px
 * column renders about 1400px tall and pushes the detections, the timeline and the run
 * settings off the screen. Capping the height and deriving max-width from the ratio
 * SHRINKS the box rather than letterboxing it, which is what keeps the overlay aligned.
 */
const MAX_STAGE_HEIGHT = "min(560px, 70svh)";

/** Used until the video reports its real dimensions. */
const FALLBACK_ASPECT_RATIO = 16 / 9;

/**
 * Video preview with the detection overlay painted on top.
 *
 * The container is given the video's own aspect ratio so the letterboxing that
 * `object-contain` would otherwise introduce cannot desynchronise the overlay from the
 * picture: normalised boxes then map straight onto canvas coordinates. Height is capped
 * by narrowing the container, never by clamping it against the ratio, for the same
 * reason - a clamped box would letterbox and the overlay would drift off the picture.
 */
export function VideoStage({
  videoRef,
  videoUrl,
  frames,
  severityByTrack,
  toleranceSeconds,
  triggerRegionTopY,
  aspectRatio,
  controls,
  onLoadedMetadata,
}: VideoStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let animationFrame = 0;

    const draw = () => {
      animationFrame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;

      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * ratio);
      const height = Math.round(canvas.clientHeight * ratio);
      if (width === 0 || height === 0) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const context = canvas.getContext("2d");
      if (!context) return;
      context.clearRect(0, 0, width, height);

      drawTriggerRegion(context, width, height, triggerRegionTopY, ratio);

      const frame = findFrameAt(frames, video.currentTime, toleranceSeconds);
      if (!frame) return;

      for (const box of buildOverlayBoxes(frame, severityByTrack)) {
        drawBox(context, box, width, height, ratio);
      }
    };

    animationFrame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animationFrame);
  }, [frames, severityByTrack, toleranceSeconds, triggerRegionTopY, videoRef]);

  const ratio = aspectRatio && aspectRatio > 0 ? aspectRatio : FALLBACK_ASPECT_RATIO;

  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-md bg-[#2c2c2c]"
      style={{ aspectRatio: ratio, maxWidth: `calc(${ratio} * ${MAX_STAGE_HEIGHT})` }}
    >
      <video
        ref={videoRef}
        src={videoUrl}
        className="h-full w-full"
        playsInline
        muted
        preload="auto"
        controls={controls}
        onLoadedMetadata={onLoadedMetadata}
      />
      <canvas
        ref={canvasRef}
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
    </div>
  );
}

const LABEL_FONT_STACK = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

function drawTriggerRegion(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  topY: number,
  ratio: number,
): void {
  const y = topY * height;
  context.save();
  // Blue marks the active reference line; severity colours stay reserved for damage.
  context.strokeStyle = "rgba(114,180,252,0.75)";
  context.lineWidth = Math.max(1, ratio);
  context.setLineDash([6 * ratio, 6 * ratio]);
  context.beginPath();
  context.moveTo(0, y);
  context.lineTo(width, y);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = "rgba(114,180,252,0.9)";
  context.font = `500 ${11 * ratio}px ${LABEL_FONT_STACK}`;
  context.fillText("Trigger region", 6 * ratio, y - 6 * ratio);
  context.restore();
}

function drawBox(
  context: CanvasRenderingContext2D,
  box: ReturnType<typeof buildOverlayBoxes>[number],
  width: number,
  height: number,
  ratio: number,
): void {
  const x = box.bbox.x * width;
  const y = box.bbox.y * height;
  const boxWidth = box.bbox.width * width;
  const boxHeight = box.bbox.height * height;

  context.save();
  context.strokeStyle = box.colour;
  context.lineWidth = (box.tracked ? 2 : 1) * ratio;
  if (!box.tracked) context.setLineDash([4 * ratio, 4 * ratio]);
  context.strokeRect(x, y, boxWidth, boxHeight);
  context.setLineDash([]);

  const fontSize = 11 * ratio;
  context.font = `600 ${fontSize}px ${LABEL_FONT_STACK}`;
  const padding = 4 * ratio;
  const textWidth = context.measureText(box.label).width;
  const labelHeight = fontSize + padding * 1.5;
  // Keep the label inside the frame when the box sits at the very top.
  const labelY = y - labelHeight < 0 ? y + boxHeight : y - labelHeight;

  context.fillStyle = box.colour;
  context.fillRect(x, labelY, textWidth + padding * 2, labelHeight);
  context.fillStyle = "#111827";
  context.fillText(box.label, x + padding, labelY + fontSize);
  context.restore();
}
