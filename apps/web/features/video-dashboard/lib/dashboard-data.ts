import type { SeverityLevel } from "@pothole/shared-types";
import type { AnalysedPothole, SampledFrame } from "@/features/analyze/lib/analyse-video";

/** Worst first, the order every card and row on the dashboard uses. */
export const SEVERITY_ORDER: SeverityLevel[] = ["large", "medium", "small", "unknown"];

export const SEVERITY_LABEL: Record<SeverityLevel, string> = {
  large: "Large",
  medium: "Medium",
  small: "Small",
  unknown: "Not graded",
};

export function severityCounts(potholes: AnalysedPothole[]): Record<SeverityLevel, number> {
  const counts: Record<SeverityLevel, number> = { large: 0, medium: 0, small: 0, unknown: 0 };
  for (const pothole of potholes) counts[pothole.severity.level] += 1;
  return counts;
}

export type ActivityBucket = {
  startSeconds: number;
  endSeconds: number;
  /** Detections that belong to a pothole the pipeline reported. */
  confirmed: number;
  /** Detections it did not keep: single sightings, or tracks that failed confirmation. */
  unconfirmed: number;
};

/** Detections per equal slice of the clip, split by whether they became a reported pothole. */
export function activityBuckets(
  frames: SampledFrame[],
  potholes: AnalysedPothole[],
  durationSeconds: number,
  buckets = 8,
): ActivityBucket[] {
  const reported = new Set(potholes.map((pothole) => pothole.trackId));
  const width = durationSeconds / buckets;
  const out: ActivityBucket[] = Array.from({ length: buckets }, (_, i) => ({
    startSeconds: i * width,
    endSeconds: (i + 1) * width,
    confirmed: 0,
    unconfirmed: 0,
  }));
  if (width <= 0) return out;
  for (const frame of frames) {
    const bucket = out[Math.min(buckets - 1, Math.max(0, Math.floor(frame.seconds / width)))]!;
    for (const { trackId } of frame.detections) {
      if (trackId !== null && reported.has(trackId)) bucket.confirmed += 1;
      else bucket.unconfirmed += 1;
    }
  }
  return out;
}

export type ConfidencePoint = { seconds: number; confidence: number };

/** The most confident pothole detection in each analysed frame; zero where there was none. */
export function confidenceSeries(frames: SampledFrame[]): ConfidencePoint[] {
  return frames.map((frame) => ({
    seconds: frame.seconds,
    confidence: frame.detections.reduce((best, d) => Math.max(best, d.detection.confidence), 0),
  }));
}

/** The confidence shown for a playback moment: the last analysed frame at or before it. */
export function confidenceAt(series: ConfidencePoint[], seconds: number): number {
  let value = 0;
  for (const point of series) {
    if (point.seconds > seconds) break;
    value = point.confidence;
  }
  return value;
}

export type TimelineRow = { level: SeverityLevel; label: string; potholes: AnalysedPothole[] };

export function timelineRows(potholes: AnalysedPothole[]): TimelineRow[] {
  return SEVERITY_ORDER.map((level) => ({
    level,
    label: SEVERITY_LABEL[level],
    potholes: potholes.filter((pothole) => pothole.severity.level === level),
  }));
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
