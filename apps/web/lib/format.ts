/** Media time as mm:ss, the format used in the detection timeline. */
export function formatTimecode(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

/** A 0..1 ratio as a whole-number percentage. */
export function formatPercent(value: number, fractionDigits = 0): string {
  if (!Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0s";
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return formatTimecode(seconds);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Inference duration. Sub-tenth-of-a-millisecond timings are reported as a bound rather
 * than as "0.0 ms", which would read as a broken measurement.
 */
export function formatLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
  if (milliseconds > 0 && milliseconds < 0.05) return "<0.1 ms";
  return `${milliseconds.toFixed(1)} ms`;
}
