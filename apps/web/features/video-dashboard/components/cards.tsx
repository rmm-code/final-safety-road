"use client";

import clsx from "clsx";
import type { SeverityLevel } from "@pothole/shared-types";
import { Badge, Panel, SeverityBadge } from "@/components/ui";
import { formatPercent } from "@/lib/format";
import type { AnalysedPothole, SampledFrame } from "@/features/analyze/lib/analyse-video";
import {
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  activityBuckets,
  confidenceAt,
  formatClock,
  severityCounts,
  timelineRows,
  type ConfidencePoint,
} from "../lib/dashboard-data";
import { ActivityChart, CHART_COLOURS, ConfidenceChart } from "./charts";

const SEVERITY_VAR: Record<SeverityLevel, string> = {
  large: "var(--color-severity-large)",
  medium: "var(--color-severity-medium)",
  small: "var(--color-severity-small)",
  unknown: "var(--color-severity-unknown)",
};

function Pending({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-[150px] place-items-center px-4 text-center text-[13px] text-muted">{children}</div>;
}

/** Pitstop's "Event overview": the total, a split meter and a legend, by severity. */
export function OverviewCard({ potholes, pending }: { potholes: AnalysedPothole[] | null; pending: string }) {
  const counts = potholes ? severityCounts(potholes) : null;
  const total = potholes?.length ?? 0;
  return (
    <Panel
      icon="dashboard"
      title="Pothole overview"
      subtitle="Potholes found in the selected video"
      bodyClassName="px-4 pb-4 pt-3"
      footer={{ label: "View pothole timeline", href: "#timeline" }}
    >
      {!counts ? (
        <Pending>{pending}</Pending>
      ) : (
        <>
          <div className="mb-4 flex items-baseline justify-between">
            <span className="text-[13px] text-[#737373]">Total potholes</span>
            <strong className="tabular text-[26px] font-semibold tracking-[-0.8px] text-primary">{total}</strong>
          </div>
          <div className="mb-3 flex h-4 gap-[3px]" aria-hidden>
            {total === 0 ? (
              <i className="flex-1 rounded-[3px] bg-fill" />
            ) : (
              SEVERITY_ORDER.filter((level) => counts[level] > 0).map((level) => (
                <i
                  key={level}
                  className="rounded-[3px] opacity-90"
                  style={{ flexGrow: counts[level], backgroundColor: SEVERITY_VAR[level] }}
                />
              ))
            )}
          </div>
          <ul className="space-y-1.5">
            {SEVERITY_ORDER.map((level) => (
              <li key={level} className="flex items-center justify-between text-[12.5px] text-[#727272]">
                <span className="flex items-center gap-[7px]">
                  <i aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: SEVERITY_VAR[level] }} />
                  {SEVERITY_LABEL[level]}
                </span>
                <b className="tabular font-medium text-[#747474]">
                  {counts[level]} {counts[level] === 1 ? "pothole" : "potholes"}
                </b>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/** Pitstop's "Traffic activity": what the detector saw, slice by slice. */
export function ActivityCard({
  frames,
  potholes,
  durationSeconds,
  rawDetections,
  pending,
}: {
  frames: SampledFrame[] | null;
  potholes: AnalysedPothole[] | null;
  durationSeconds: number;
  rawDetections: number | null;
  pending: string;
}) {
  return (
    <Panel
      icon="drive"
      title="Detection activity"
      subtitle="What the detector saw across the video"
      bodyClassName="px-4 pb-2 pt-3"
      footer={{ label: "View every pothole photo", href: "/potholes" }}
    >
      {!frames || !potholes ? (
        <Pending>{pending}</Pending>
      ) : (
        <>
          <div className="mb-1 flex items-baseline gap-2">
            <strong className="tabular text-[26px] font-semibold tracking-[-0.8px] text-primary">{rawDetections ?? 0}</strong>
            <span className="text-[13px] text-[#737373]">frame detections</span>
          </div>
          <div className="h-[200px]">
            <ActivityChart buckets={activityBuckets(frames, potholes, durationSeconds)} />
          </div>
          <div className="flex justify-center gap-5 pb-2 text-[12px] text-[#737373]">
            <span className="flex items-center gap-1.5">
              <i aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: CHART_COLOURS.confirmed }} />
              Became a reported pothole
            </span>
            <span className="flex items-center gap-1.5">
              <i aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: CHART_COLOURS.unconfirmed }} />
              Not kept
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Pitstop's "Risk over time", for potholes: the detector's confidence as the video plays. */
export function ConfidenceCard({
  series,
  threshold,
  durationSeconds,
  currentSeconds,
  pending,
}: {
  series: ConfidencePoint[] | null;
  threshold: number;
  durationSeconds: number;
  currentSeconds: number;
  pending: string;
}) {
  const now = series ? confidenceAt(series, currentSeconds) : 0;
  const above = now >= threshold;
  return (
    <Panel
      icon="chartLine"
      title="Confidence over time"
      subtitle="The detector's most confident pothole in each frame"
      bodyClassName="px-3 pb-2 pt-2"
      footer={{ label: "Detector confidence, not a calibrated probability" }}
    >
      {!series ? (
        <Pending>{pending}</Pending>
      ) : (
        <>
          <div className="flex items-center gap-2 px-2 pt-1">
            <strong className="tabular text-[25px] font-semibold tracking-[-0.8px] text-primary">{formatPercent(now)}</strong>
            <span className="text-[12px] text-[#737373]">at {formatClock(currentSeconds)}</span>
            <Badge tone={above ? "warn" : "ok"} className="ml-auto">
              {above ? "Above threshold" : "Below threshold"}
            </Badge>
          </div>
          <div className="mt-2 h-[160px]">
            <ConfidenceChart series={series} threshold={threshold} durationSeconds={durationSeconds} currentSeconds={currentSeconds} />
          </div>
          <div className="flex justify-center gap-5 py-2 text-[11.5px] text-[#737373]">
            <span className="flex items-center gap-1.5">
              <i aria-hidden className="h-[6px] w-[6px] rounded-[2px]" style={{ backgroundColor: CHART_COLOURS.line }} />
              Confidence
            </span>
            <span className="flex items-center gap-1.5">
              <i aria-hidden className="w-3 border-t border-dashed" style={{ borderColor: CHART_COLOURS.threshold }} />
              Threshold {threshold.toFixed(2)}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}

/** Pitstop's "Event timeline": one row per severity; a mark jumps the video to it. */
export function TimelineCard({
  potholes,
  durationSeconds,
  onSelect,
  pending,
}: {
  potholes: AnalysedPothole[] | null;
  durationSeconds: number;
  onSelect: (pothole: AnalysedPothole) => void;
  pending: string;
}) {
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return (
    <div id="timeline" className="scroll-mt-4">
      <Panel
        icon="clock"
        title="Pothole timeline"
        subtitle="One row for each severity. Click a pothole to jump the video to it."
        bodyClassName="px-4 pb-4 pt-2"
      >
        {!potholes ? (
          <Pending>{pending}</Pending>
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[560px]">
              <div className="grid grid-cols-[150px_1fr] border-b border-[#efefef] pb-2 text-[11px] uppercase tracking-[0.06em] text-[#8a8a8a]">
                <span>Severity</span>
                <div className="relative h-4">
                  {ticks.map((t) => (
                    <span
                      key={t}
                      className="tabular absolute normal-case tracking-normal"
                      style={{ left: `${t * 100}%`, transform: t === 0 ? "none" : t === 1 ? "translateX(-100%)" : "translateX(-50%)" }}
                    >
                      {formatClock(durationSeconds * t)}
                    </span>
                  ))}
                </div>
              </div>
              {timelineRows(potholes).map((row) => (
                <div key={row.level} className="grid min-h-[38px] grid-cols-[150px_1fr] items-center border-b border-[#f3f3f3] last:border-b-0">
                  <span className="flex items-center justify-between pr-4 text-[13.5px] text-[#3a3a3a]">
                    {row.label}
                    <span className="tabular text-[#555]">{row.potholes.length}</span>
                  </span>
                  <div className="relative h-7">
                    {row.potholes.length === 0 && (
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[12.5px] text-[#9a9a9a]">None found in this video</span>
                    )}
                    {row.potholes.map((pothole) => {
                      const left = durationSeconds > 0 ? (pothole.firstSeenSeconds / durationSeconds) * 100 : 0;
                      const span = durationSeconds > 0 ? ((pothole.lastSeenSeconds - pothole.firstSeenSeconds) / durationSeconds) * 100 : 0;
                      return (
                        <button
                          key={pothole.trackId}
                          type="button"
                          onClick={() => onSelect(pothole)}
                          title={`${row.label} pothole at ${formatClock(pothole.bestFrameSeconds ?? pothole.firstSeenSeconds)}, ${formatPercent(pothole.confidence)} confidence`}
                          aria-label={`Jump to the ${row.label.toLowerCase()} pothole at ${formatClock(pothole.bestFrameSeconds ?? pothole.firstSeenSeconds)}`}
                          className="absolute top-1/2 h-[18px] min-w-[9px] -translate-y-1/2 rounded-[4px] transition-transform duration-150 hover:scale-110"
                          style={{ left: `${left}%`, width: `${Math.max(span, 0.8)}%`, backgroundColor: SEVERITY_VAR[row.level] }}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Every pothole in the video as its evidence photo, worst first. */
export function PhotosCard({
  potholes,
  onSelect,
  pending,
}: {
  potholes: AnalysedPothole[] | null;
  onSelect: (pothole: AnalysedPothole) => void;
  pending: string;
}) {
  const ordered = potholes
    ? [...potholes].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity.level) - SEVERITY_ORDER.indexOf(b.severity.level))
    : null;
  return (
    <Panel icon="images" title="Potholes in this video" subtitle="The best evidence frame of each, worst first" bodyClassName="p-3">
      {!ordered ? (
        <Pending>{pending}</Pending>
      ) : ordered.length === 0 ? (
        <Pending>No pothole was confirmed in this video.</Pending>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
          {ordered.map((pothole) => {
            const photo = pothole.cropImage ?? pothole.fullImage;
            const at = formatClock(pothole.bestFrameSeconds ?? pothole.firstSeenSeconds);
            return (
              <button
                key={pothole.trackId}
                type="button"
                onClick={() => onSelect(pothole)}
                className="group overflow-hidden rounded-lg border border-[#ebebeb] bg-white text-left transition-shadow duration-150 hover:shadow-pop"
              >
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- an evidence crop, in memory or from storage
                  <img
                    src={photo}
                    alt={`Pothole at ${at}`}
                    // The page is cross-origin isolated; saved photos come from storage, which answers CORS.
                    crossOrigin="anonymous"
                    className="aspect-[4/3] w-full bg-[#2c2c2c] object-cover"
                  />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center bg-subtle text-[12px] text-muted">No photo</div>
                )}
                <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                  <SeverityBadge level={pothole.severity.level} />
                  <span className="tabular text-[12px] text-[#737373]">
                    {at} · {formatPercent(pothole.confidence)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** Where the video was filmed, if anyone knows: files carry no GPS. */
export function LocationCard({
  label,
  latitude,
  longitude,
  accuracyM,
  children,
}: {
  label: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  children?: React.ReactNode;
}) {
  const located = latitude !== null && longitude !== null;
  return (
    <Panel
      icon="map"
      title="On the map"
      subtitle={located ? "Placed by hand: video files carry no GPS" : "Video files carry no GPS"}
      bodyClassName={clsx("p-3", !located && "px-4")}
      footer={located ? { label: "Open the map", href: "/map" } : undefined}
    >
      {children}
      {located ? (
        <p className="mt-2 text-[12.5px] leading-[18px] text-[#6a6a6a]">
          {label ?? "Placed by hand"} · within {accuracyM ?? 100} m
        </p>
      ) : (
        !children && <p className="text-[13px] leading-5 text-[#6a6a6a]">Nobody has placed this video yet.</p>
      )}
    </Panel>
  );
}
