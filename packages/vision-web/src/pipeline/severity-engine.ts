import type { PotholeTrack, SeverityLevel, SeverityResult } from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import { areaScore, clamp01 } from "./scores";

/**
 * Produces a VISUAL severity for a finalised track.
 *
 * Severity is deliberately not a detector class. Keeping it here means severity can be
 * retuned, or later upgraded with depth estimation and IMU shock, without retraining
 * the detector.
 *
 * This engine claims nothing about physical width, length or depth: a single
 * uncalibrated phone camera cannot measure them.
 */
export interface SeverityEngine {
  calculate(track: PotholeTrack): SeverityResult;
}

export class VisualSeverityEngine implements SeverityEngine {
  private readonly config: VisionConfig;

  constructor(config: VisionConfig) {
    this.config = config;
  }

  calculate(track: PotholeTrack): SeverityResult {
    const { severity, tracking } = this.config;

    if (track.observations.length === 0) {
      return {
        level: "unknown",
        score: 0,
        confidence: 0,
        rationale: "No observations recorded for this track.",
      };
    }

    // Prefer observations from the trigger region: a pothole close to the vehicle
    // fills a predictable share of the frame, whereas a distant one looks tiny
    // regardless of how bad it is.
    const triggerObservations = track.observations.filter((o) => o.inTriggerRegion);
    const measured = triggerObservations.length > 0 ? triggerObservations : track.observations;
    const peakArea = measured.reduce((max, o) => Math.max(max, o.area), 0);

    if (peakArea <= 0) {
      return {
        level: "unknown",
        score: 0,
        confidence: 0,
        rationale: "Track has no positive visible area.",
      };
    }

    const score = areaScore(peakArea, severity.areaScoreReference);
    const level = this.levelFor(score);

    const weights = severity.confidenceWeights;
    const persistence = clamp01(
      track.observations.length / severity.persistenceReferenceObservations,
    );
    const confidence = clamp01(
      weights.base +
        weights.detection * clamp01(track.maxConfidence) +
        weights.persistence * persistence +
        weights.triggerRegion * (triggerObservations.length > 0 ? 1 : 0),
    );

    const measuredIn = triggerObservations.length > 0 ? "trigger region" : "full frame";
    const rationale =
      `Peak visible area ${(peakArea * 100).toFixed(2)}% of frame ` +
      `(measured in ${measuredIn}, reference ${(severity.areaScoreReference * 100).toFixed(1)}%), ` +
      `${track.observations.length} observation(s), peak detector confidence ` +
      `${(track.maxConfidence * 100).toFixed(0)}%.` +
      (track.observations.length < tracking.minObservations
        ? " Fewer observations than the confirmation minimum."
        : "");

    return { level, score, confidence, rationale };
  }

  private levelFor(score: number): SeverityLevel {
    const { smallMax, mediumMax } = this.config.severity;
    if (score <= smallMax) return "small";
    if (score <= mediumMax) return "medium";
    return "large";
  }
}
