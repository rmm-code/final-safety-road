import type { ActivityBucket, ConfidencePoint } from "../lib/dashboard-data";
import { formatClock } from "../lib/dashboard-data";

const CONFIRMED = "#6ba8ed";
const UNCONFIRMED = "#efb66c";
const LINE = "#2f2f2f";
const THRESHOLD = "#d8aa5f";
const GRID = "#efefef";
const AXIS_TEXT = "#8a8a8a";

/** Grouped bars per slice of the clip: confirmed potholes beside the detections not kept. */
export function ActivityChart({ buckets }: { buckets: ActivityBucket[] }) {
  const width = 600;
  const height = 210;
  const top = 10;
  const bottom = 26;
  const plot = height - top - bottom;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.confirmed, b.unconfirmed)));
  const slot = width / Math.max(1, buckets.length);
  const bar = Math.min(18, slot / 3.2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Detections per part of the video">
      {[0.5, 1].map((f) => (
        <line key={f} x1="0" x2={width} y1={top + plot * (1 - f)} y2={top + plot * (1 - f)} stroke={GRID} />
      ))}
      {buckets.map((bucket, i) => {
        const centre = slot * i + slot / 2;
        const confirmedH = (bucket.confirmed / max) * plot;
        const unconfirmedH = (bucket.unconfirmed / max) * plot;
        return (
          <g key={i}>
            <rect x={centre - bar - 2} y={top + plot - confirmedH} width={bar} height={Math.max(confirmedH, 1.5)} rx="2" fill={CONFIRMED} />
            <rect x={centre + 2} y={top + plot - unconfirmedH} width={bar} height={Math.max(unconfirmedH, 1.5)} rx="2" fill={UNCONFIRMED} />
            <text x={centre} y={height - 8} textAnchor="middle" fontSize="12" fill={AXIS_TEXT}>
              {formatClock(bucket.startSeconds)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** The detector's top confidence per analysed frame, the threshold, and where playback is. */
export function ConfidenceChart({
  series,
  threshold,
  durationSeconds,
  currentSeconds,
}: {
  series: ConfidencePoint[];
  threshold: number;
  durationSeconds: number;
  currentSeconds: number;
}) {
  const width = 600;
  const height = 170;
  const left = 40;
  const right = 8;
  const top = 8;
  const bottom = 24;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const x = (s: number) => left + (durationSeconds > 0 ? (s / durationSeconds) * plotW : 0);
  const y = (c: number) => top + plotH * (1 - c);
  const path = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.seconds).toFixed(1)},${y(p.confidence).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="Detector confidence over the video">
      {[0, 0.5, 1].map((c) => (
        <g key={c}>
          <line x1={left} x2={width - right} y1={y(c)} y2={y(c)} stroke={GRID} />
          <text x={left - 8} y={y(c) + 4} textAnchor="end" fontSize="12" fill={AXIS_TEXT}>
            {Math.round(c * 100)}%
          </text>
        </g>
      ))}
      <line x1={left} x2={width - right} y1={y(threshold)} y2={y(threshold)} stroke={THRESHOLD} strokeDasharray="5 4" />
      {path && <path d={path} fill="none" stroke={LINE} strokeWidth="1.4" strokeLinejoin="round" />}
      <line x1={x(currentSeconds)} x2={x(currentSeconds)} y1={top} y2={top + plotH} stroke="#9a9a9a" strokeDasharray="2 3" />
      {ticks.map((t) => (
        <text key={t} x={left + plotW * t} y={height - 6} textAnchor={t === 0 ? "start" : t === 1 ? "end" : "middle"} fontSize="12" fill={AXIS_TEXT}>
          {formatClock(durationSeconds * t)}
        </text>
      ))}
    </svg>
  );
}

export const CHART_COLOURS = { confirmed: CONFIRMED, unconfirmed: UNCONFIRMED, line: LINE, threshold: THRESHOLD };
