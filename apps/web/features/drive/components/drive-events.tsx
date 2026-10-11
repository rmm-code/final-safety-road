"use client";

import Image from "next/image";
import { SeverityBadge } from "@/components/ui";
import type { DriveEvent } from "../lib/drive-recorder";

function clockAt(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Events captured during this drive.
 *
 * Rejected events are listed alongside accepted ones, with the reason. A pothole that was
 * seen but could not be placed is information the operator needs - silently dropping it
 * would make the system look better than it is.
 */
export function DriveEvents({ events }: { events: DriveEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="py-6 text-center text-[13px] text-muted">
        Potholes captured during this drive will appear here.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-border">
      {[...events].reverse().map((event) => (
        <li key={event.trackId} className="flex items-center gap-3 py-2.5">
          {event.cropImage ? (
            <Image
              src={event.cropImage}
              alt=""
              width={56}
              height={40}
              unoptimized
              className="h-10 w-14 shrink-0 rounded-md object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="grid h-10 w-14 shrink-0 place-items-center rounded-md bg-subtle font-mono text-[9px] text-muted"
            >
              no img
            </span>
          )}

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <SeverityBadge level={event.severity.level} />
              <span className="font-mono text-[13px] tabular-nums text-primary">
                {Math.round(event.confidence * 100)}%
              </span>
              <span className="font-mono text-[11px] tabular-nums text-muted">
                {clockAt(event.detectedAtMs)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-secondary">
              {event.build.ok ? (
                <>
                  Queued · {event.build.event.latitude.toFixed(5)},{" "}
                  {event.build.event.longitude.toFixed(5)} ±
                  {Math.round(event.build.event.locationAccuracyM)} m
                </>
              ) : (
                <span className="text-red">Not queued · {event.build.detail}</span>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
