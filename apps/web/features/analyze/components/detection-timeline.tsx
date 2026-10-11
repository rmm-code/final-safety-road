"use client";

import clsx from "clsx";
import Image from "next/image";
import type { SeverityLevel } from "@pothole/shared-types";
import { SeverityBadge } from "@/components/ui";
import { formatPercent, formatTimecode } from "@/lib/format";
import type { AnalysedPothole } from "../lib/analyse-video";

type DetectionTimelineProps = {
  potholes: readonly AnalysedPothole[];
  selectedTrackId: string | null;
  onSelect: (pothole: AnalysedPothole) => void;
};

/**
 * Shared column template, so the header and every row stay in one grid. Narrow screens
 * drop the sightings count and the track identifier rather than squeezing every column:
 * time, severity and confidence are what a phone-sized readout needs.
 */
const ROW_GRID =
  "grid grid-cols-[52px_1fr_78px_56px] items-center gap-3 px-4 sm:grid-cols-[52px_56px_78px_56px_64px_1fr]";

const MARKER_COLOURS: Record<SeverityLevel, string> = {
  small: "bg-severity-small",
  medium: "bg-severity-medium",
  large: "bg-severity-large",
  unknown: "bg-severity-unknown",
};

/**
 * Where each pothole falls across the recording.
 *
 * Reading the table tells an operator what was found; the strip tells them whether the
 * damage is spread along the route or concentrated in one stretch of road.
 */
export function DetectionStrip({
  potholes,
  durationSeconds,
  selectedTrackId,
  onSelect,
}: DetectionTimelineProps & { durationSeconds: number }) {
  if (potholes.length === 0 || durationSeconds <= 0) return null;

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-strong" />
        {potholes.map((pothole) => {
          const seconds = pothole.bestFrameSeconds ?? pothole.firstSeenSeconds;
          const position = Math.min(100, Math.max(0, (seconds / durationSeconds) * 100));
          const selected = pothole.trackId === selectedTrackId;

          return (
            <button
              key={pothole.trackId}
              type="button"
              onClick={() => onSelect(pothole)}
              title={`${pothole.severity.level} at ${formatTimecode(seconds)}`}
              style={{ left: `${position}%` }}
              className={clsx(
                "absolute top-1/2 h-5 w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-[2px] transition-transform duration-150",
                MARKER_COLOURS[pothole.severity.level],
                selected && "h-7 ring-2 ring-primary",
              )}
            >
              <span className="sr-only">
                {pothole.severity.level} pothole at {formatTimecode(seconds)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="tabular mt-1 flex justify-between font-mono text-[11px] text-muted">
        <span>{formatTimecode(0)}</span>
        <span>{formatTimecode(durationSeconds)}</span>
      </div>
    </div>
  );
}

/**
 * One row per unique pothole, not per frame detection. Selecting a row seeks the video
 * to the evidence frame so a result can always be checked against the footage.
 */
export function DetectionTimeline({
  potholes,
  selectedTrackId,
  onSelect,
}: DetectionTimelineProps) {
  if (potholes.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-secondary">
        No potholes met the confirmation rules in this video.
      </p>
    );
  }

  return (
    <div>
      <div
        aria-hidden
        className={clsx(
          ROW_GRID,
          "border-b border-border py-2 text-[12px] leading-[18px] text-secondary",
        )}
      >
        <span />
        <span>Time</span>
        <span>Severity</span>
        <span className="text-right">Conf.</span>
        <span className="hidden text-right sm:block">Sightings</span>
        <span className="hidden sm:block">Pothole</span>
      </div>

      <ul className="divide-y divide-border">
        {potholes.map((pothole) => {
          const selected = pothole.trackId === selectedTrackId;
          const seconds = pothole.bestFrameSeconds ?? pothole.firstSeenSeconds;

          return (
            <li key={pothole.trackId}>
              <button
                type="button"
                onClick={() => onSelect(pothole)}
                aria-current={selected ? "true" : undefined}
                className={clsx(
                  ROW_GRID,
                  "w-full py-2 text-left text-[13px] transition-colors duration-150 hover:bg-hover",
                  selected && "bg-blue-soft hover:bg-blue-soft",
                )}
              >
                {pothole.cropImage ? (
                  <Image
                    src={pothole.cropImage}
                    alt=""
                    width={52}
                    height={30}
                    unoptimized
                    className="h-[30px] w-[52px] rounded-md object-cover"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="grid h-[30px] w-[52px] place-items-center rounded-md bg-subtle text-[10px] text-muted"
                  >
                    No image
                  </span>
                )}

                <span className="tabular font-mono">{formatTimecode(seconds)}</span>
                <SeverityBadge level={pothole.severity.level} />
                <span className="tabular text-right font-mono text-secondary">
                  {formatPercent(pothole.confidence)}
                </span>
                <span className="tabular hidden text-right font-mono text-secondary sm:block">
                  {pothole.observationCount}
                  <span className="sr-only"> sightings</span>
                </span>
                <span className="hidden truncate font-mono text-[12px] text-muted sm:block">
                  {pothole.trackId}
                  <span className="ml-2 hidden md:inline">
                    {formatTimecode(pothole.firstSeenSeconds)}&#8202;&rarr;&#8202;
                    {formatTimecode(pothole.lastSeenSeconds)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
