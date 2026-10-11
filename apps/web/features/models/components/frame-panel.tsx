"use client";

import type { FrameBoxes } from "../lib/compare-data";

/**
 * One frame with one model's pothole boxes over it.
 *
 * Boxes are positioned in percentages over the image rather than painted into a canvas:
 * the predictions are already normalised, so they stay aligned at any width the grid gives
 * the panel, and there is no resize handler to keep in step.
 */
export function FramePanel({
  src,
  aspect,
  boxes,
  threshold,
  colour,
  title,
  subtitle,
  emptyNote,
}: {
  src: string;
  /** width / height of the frame. */
  aspect: number;
  boxes: FrameBoxes | undefined;
  threshold: number;
  colour: string;
  title: string;
  subtitle?: string;
  emptyNote?: string;
}) {
  const shown = (boxes ?? []).filter((box) => box[4] >= threshold);

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
          <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: colour }} />
          <span className="truncate">{title}</span>
        </span>
        <span className="tabular shrink-0 font-mono text-[12px] text-secondary">
          {shown.length} {shown.length === 1 ? "pothole" : "potholes"}
        </span>
      </figcaption>

      <div
        className="relative mx-auto w-full overflow-hidden rounded-xl bg-[#0b0f17]"
        // Capped like the analyze stage: portrait footage must not become a page-tall box.
        style={{ aspectRatio: aspect, maxWidth: `calc(${aspect} * min(520px, 62svh))` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="" className="h-full w-full" draggable={false} />
        {shown.map(([x1, y1, x2, y2, score], index) => (
          <div
            key={index}
            className="pointer-events-none absolute border-2"
            style={{
              left: `${x1 * 100}%`,
              top: `${y1 * 100}%`,
              width: `${(x2 - x1) * 100}%`,
              height: `${(y2 - y1) * 100}%`,
              borderColor: colour,
            }}
          >
            <span
              className="tabular absolute -top-[18px] left-[-2px] px-1 font-mono text-[10px] font-semibold leading-[16px] text-white"
              style={{ backgroundColor: colour }}
            >
              {Math.round(score * 100)}
            </span>
          </div>
        ))}
        {shown.length === 0 && emptyNote && (
          <p className="absolute inset-x-2 bottom-2 rounded bg-black/55 px-2 py-1 text-center text-[11px] text-white">
            {emptyNote}
          </p>
        )}
      </div>
      {subtitle && <p className="mt-1.5 text-[12px] leading-4 text-muted">{subtitle}</p>}
    </figure>
  );
}
