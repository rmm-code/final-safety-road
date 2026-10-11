"use client";

import { useEffect, useRef } from "react";
import type { Detection } from "@pothole/shared-types";

/**
 * Colour of a detection box over the live camera.
 *
 * Green, not the severity palette: while driving, the only question the box answers is
 * "did it see something", and severity is not even known until the track finalises. The
 * severity colours still do their job in the event list and on the map.
 */
const DETECTION_STROKE = "#22A06B";

export type LiveOverlay = {
  detections: Detection[];
};

/**
 * Where the video frame actually lands inside its box.
 *
 * The preview is `object-cover`, so a frame whose shape differs from the box is scaled to
 * fill it and cropped. Boxes are normalised to the frame, not the box; drawing them
 * against the box puts every one of them in the wrong place.
 */
function coverRect(boxWidth: number, boxHeight: number, video: HTMLVideoElement | null) {
  const frameWidth = video?.videoWidth ?? 0;
  const frameHeight = video?.videoHeight ?? 0;
  if (!frameWidth || !frameHeight) return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  const scale = Math.max(boxWidth / frameWidth, boxHeight / frameHeight);
  const width = frameWidth * scale;
  const height = frameHeight * scale;
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height };
}

/**
 * Camera preview with the detection overlay.
 *
 * The overlay is painted on its own canvas rather than composited into the video, so the
 * preview keeps running at the camera's full frame rate while inference proceeds at a
 * fraction of it. Boxes are thin outlines with a small label - a driver glances at this,
 * and anything heavier obscures the road it is drawn over.
 */
export function CameraStage({
  videoRef,
  overlayRef,
  triggerRegionTopY,
  muted = true,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  overlayRef: React.MutableRefObject<LiveOverlay>;
  triggerRegionTopY: number;
  muted?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;

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

      const area = coverRect(width, height, videoRef.current);
      const triggerY = area.y + triggerRegionTopY * area.height;
      context.save();
      context.strokeStyle = "rgba(255,255,255,0.35)";
      context.lineWidth = Math.max(1, ratio);
      context.setLineDash([8 * ratio, 8 * ratio]);
      context.beginPath();
      context.moveTo(0, triggerY);
      context.lineTo(width, triggerY);
      context.stroke();
      context.restore();

      for (const detection of overlayRef.current.detections) {
        const colour = DETECTION_STROKE;
        const x = area.x + detection.bbox.x * area.width;
        const y = area.y + detection.bbox.y * area.height;
        const boxWidth = detection.bbox.width * area.width;
        const boxHeight = detection.bbox.height * area.height;

        context.save();
        context.strokeStyle = colour;
        context.lineWidth = 2 * ratio;
        context.strokeRect(x, y, boxWidth, boxHeight);

        const label = `POTHOLE · ${Math.round(detection.confidence * 100)}%`;
        const fontSize = 12 * ratio;
        context.font = `600 ${fontSize}px ui-monospace, monospace`;
        const padding = 5 * ratio;
        const textWidth = context.measureText(label).width;
        const labelHeight = fontSize + padding * 1.4;
        const labelY = y - labelHeight < 0 ? y + boxHeight : y - labelHeight;

        context.fillStyle = colour;
        context.fillRect(x, labelY, textWidth + padding * 2, labelHeight);
        context.fillStyle = "#111827";
        context.fillText(label, x + padding, labelY + fontSize);
        context.restore();
      }
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [overlayRef, triggerRegionTopY, videoRef]);

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-black sm:aspect-video">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        playsInline
        muted={muted}
        autoPlay
      />
      <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />
    </div>
  );
}
