import type { LocationSample } from "@pothole/shared-types";

/**
 * Timestamped ring buffer of GPS samples.
 *
 * A detection and a location fix never arrive at the same instant: the camera produces
 * frames continuously while the browser delivers positions roughly once a second. To
 * place a pothole we therefore have to look up the position that was current *at the
 * moment the pothole was seen*, not simply the newest one.
 *
 * Only the recent past is kept. Older samples cannot be relevant to a detection that is
 * being finalised now, and an unbounded buffer would grow for the whole drive.
 */
export class LocationBuffer {
  private samples: LocationSample[] = [];
  private readonly retentionMs: number;

  constructor(options?: { retentionMs?: number }) {
    // 60 s covers the longest plausible gap between first sighting and finalisation.
    this.retentionMs = options?.retentionMs ?? 60_000;
  }

  get size(): number {
    return this.samples.length;
  }

  /** All retained samples, oldest first. */
  get all(): readonly LocationSample[] {
    return this.samples;
  }

  /**
   * Record a sample. Samples usually arrive in order, but a browser may deliver one late,
   * so insertion keeps the buffer sorted rather than assuming.
   */
  add(sample: LocationSample): void {
    const last = this.samples[this.samples.length - 1];
    if (!last || sample.timestamp >= last.timestamp) {
      this.samples.push(sample);
    } else {
      const index = this.upperBound(sample.timestamp);
      this.samples.splice(index, 0, sample);
    }
    this.prune(sample.timestamp);
  }

  /** Most recent sample, or null when no fix has arrived yet. */
  latest(): LocationSample | null {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /**
   * Sample closest in time to `timestampMs`.
   *
   * `maxAgeMs` bounds how far apart they may be: a fix from thirty seconds either side of
   * a detection describes a different piece of road, and using it would place the marker
   * hundreds of metres away. Returning null is the honest answer, and the caller rejects
   * the event rather than inventing a position.
   */
  nearestTo(timestampMs: number, maxAgeMs = 5_000): LocationSample | null {
    if (this.samples.length === 0) return null;

    const index = this.upperBound(timestampMs);
    const after = this.samples[index];
    const before = this.samples[index - 1];

    let best: LocationSample | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of [before, after]) {
      if (!candidate) continue;
      const distance = Math.abs(candidate.timestamp - timestampMs);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }

    if (!best || bestDistance > maxAgeMs) return null;
    return best;
  }

  clear(): void {
    this.samples = [];
  }

  /** Index of the first sample strictly after `timestampMs`. */
  private upperBound(timestampMs: number): number {
    let low = 0;
    let high = this.samples.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.samples[mid] as LocationSample).timestamp <= timestampMs) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    let firstKept = 0;
    while (
      firstKept < this.samples.length &&
      (this.samples[firstKept] as LocationSample).timestamp < cutoff
    ) {
      firstKept += 1;
    }
    if (firstKept > 0) this.samples.splice(0, firstKept);
  }
}
