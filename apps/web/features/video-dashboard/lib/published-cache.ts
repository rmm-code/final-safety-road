/** Well under the 6 hours the API presigns photo and overlay links for. */
const MAX_AGE_MS = 30 * 60_000;

/**
 * Published analyses kept for the tab, so switching samples is instant.
 *
 * An entry is dropped long before the links it holds expire. A result analysed in this
 * browser is never kept: cached after a transient failure, it would hide the published
 * analysis until the page reloads.
 */
export class PublishedCache<T extends { saved: boolean }> {
  private readonly entries = new Map<string, { value: T; storedAt: number }>();
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor({ maxAgeMs = MAX_AGE_MS, now = Date.now }: { maxAgeMs?: number; now?: () => number } = {}) {
    this.maxAgeMs = maxAgeMs;
    this.now = now;
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.storedAt < this.maxAgeMs) return entry.value;
    this.entries.delete(key);
    return null;
  }

  set(key: string, value: T): void {
    if (value.saved) this.entries.set(key, { value, storedAt: this.now() });
  }
}
