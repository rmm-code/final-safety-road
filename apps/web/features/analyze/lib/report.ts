import type { SeverityLevel, VideoAnalysisReport, VideoTrackSummary } from "@pothole/shared-types";
import type { VisionConfig } from "@pothole/vision-web";
import type { AnalysedPothole, VideoAnalysisResult } from "./analyse-video";

export type AnalysisSummary = {
  total: number;
  small: number;
  medium: number;
  large: number;
  unknown: number;
  /** Mean of each pothole's peak confidence, 0..1. Zero when nothing was found. */
  averageConfidence: number;
};

export function summarise(potholes: readonly AnalysedPothole[]): AnalysisSummary {
  const counts: Record<SeverityLevel, number> = { small: 0, medium: 0, large: 0, unknown: 0 };
  let confidenceTotal = 0;

  for (const pothole of potholes) {
    counts[pothole.severity.level] += 1;
    confidenceTotal += pothole.confidence;
  }

  return {
    total: potholes.length,
    ...counts,
    averageConfidence: potholes.length === 0 ? 0 : confidenceTotal / potholes.length,
  };
}

export function toTrackSummary(pothole: AnalysedPothole): VideoTrackSummary {
  return {
    trackId: pothole.trackId,
    firstSeenSeconds: round(pothole.firstSeenSeconds, 3),
    lastSeenSeconds: round(pothole.lastSeenSeconds, 3),
    maxConfidence: round(pothole.confidence, 4),
    severity: pothole.severity.level,
    severityScore: round(pothole.severity.score, 4),
    severityConfidence: round(pothole.severity.confidence, 4),
    observationCount: pothole.observationCount,
    maxArea: round(pothole.maxArea, 6),
    bestFrameSeconds: pothole.bestFrameSeconds === null ? null : round(pothole.bestFrameSeconds, 3),
  };
}

/**
 * Build the exported analysis report.
 *
 * The engine block travels with the results on purpose: a report produced by the
 * synthetic engine must be identifiable as synthetic long after it leaves the browser.
 * An uploaded file carries no telemetry, so `location` states that coordinates are
 * unavailable rather than inventing any.
 */
export function buildReport(input: {
  result: VideoAnalysisResult;
  fileName: string;
  config: VisionConfig;
  generatedAt?: Date;
}): VideoAnalysisReport {
  const { result, fileName, config } = input;
  const summary = summarise(result.potholes);

  return {
    schemaVersion: 1,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    source: {
      name: fileName,
      durationSeconds: round(result.durationSeconds, 3),
      width: result.width,
      height: result.height,
    },
    engine: result.engine,
    analysis: {
      sampleFps: config.analysis.sampleFps,
      framesAnalysed: result.framesAnalysed,
      confidenceThreshold: config.detection.confidenceThreshold,
      iouMatchThreshold: config.tracking.iouMatchThreshold,
      minObservations: config.tracking.minObservations,
      rawDetections: result.rawDetections,
      rejectedTracks: result.rejectedTracks,
      otherClasses: result.otherClasses,
    },
    location: {
      available: false,
      reason:
        "Uploaded video files carry no GPS telemetry. Coordinates are recorded only for live drive sessions.",
    },
    summary: {
      totalPotholes: summary.total,
      small: summary.small,
      medium: summary.medium,
      large: summary.large,
      unknown: summary.unknown,
      averageConfidence: round(summary.averageConfidence, 4),
    },
    tracks: result.potholes.map(toTrackSummary),
  };
}

/** Filename for a downloaded report, derived from the analysed video. */
export function reportFileName(videoName: string): string {
  const base =
    videoName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "analysis";
  return `${base}-detections.json`;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
