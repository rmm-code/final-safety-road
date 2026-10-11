/**
 * A timestamped GPS sample. Consumed by the LocationBuffer from Milestone 2 onward.
 * Uploaded-video analysis has no telemetry, so location stays null and must never be
 * invented.
 */
export type LocationSample = {
  /** Epoch milliseconds. */
  timestamp: number;
  lat: number;
  lng: number;
  /** Reported horizontal accuracy in metres. Always stored; never assume exactness. */
  accuracyM: number;
  speedMps: number | null;
  headingDeg: number | null;
};
