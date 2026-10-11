/**
 * Sequential, zero-padded local identifiers ("track-001").
 *
 * Local track ids are deterministic on purpose so that analysing the same video twice
 * yields the same report. Server-facing identifiers (clientEventId) are UUIDs and are
 * generated separately when an event is built.
 */
export function createSequentialIdFactory(prefix: string, pad = 3): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `${prefix}-${String(next).padStart(pad, "0")}`;
  };
}
