/**
 * Visual severity only. A single uncalibrated camera cannot measure physical width,
 * length or depth, so the UI must always say "visual severity".
 */
export type SeverityLevel = "small" | "medium" | "large" | "unknown";

export type SeverityResult = {
  level: SeverityLevel;
  /** 0..1 severity score produced from visual features. */
  score: number;
  /** 0..1 confidence in the severity assignment itself (not the detection). */
  confidence: number;
  /** Human-readable explanation of which features drove the result. */
  rationale: string;
};
