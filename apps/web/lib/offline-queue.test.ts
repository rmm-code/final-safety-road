import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DetectionEventPayload } from "@pothole/shared-types";
import { OfflineEventQueue } from "./offline-queue";

function payload(id: string): DetectionEventPayload {
  return {
    clientEventId: id,
    driveSessionId: "session-1",
    detectedAt: "2026-08-17T09:00:00.000Z",
    confidence: 0.92,
    severity: "large",
    severityScore: 0.82,
    severityConfidence: 0.78,
    latitude: 41.3112,
    longitude: 69.2797,
    locationAccuracyM: 8.4,
    headingDeg: 123,
    speedMps: 8.9,
    modelVersion: "pothole-detector-0.1.0",
  };
}

let queue: OfflineEventQueue;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  queue = await OfflineEventQueue.open(`test-db-${counter}`);
});

describe("queueing events", () => {
  it("stores an event for later upload", async () => {
    await queue.enqueue(payload("a"));
    const pending = await queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.state).toBe("PENDING_UPLOAD");
  });

  it("keeps the evidence images with the event", async () => {
    await queue.enqueue(payload("a"), { cropImage: "data:image/webp;base64,xx" });
    expect((await queue.get("a"))?.cropImage).toBe("data:image/webp;base64,xx");
  });

  it("never stores a synthetic sighting, so it can never be uploaded", async () => {
    // A failed model load falls back to the mock engine. Its boxes are fabricated; one that
    // reached the server would sit at a real GPS position as a real sighting.
    await queue.enqueue({ ...payload("a"), modelVersion: "mock-synthetic-0.1.0" });
    expect(await queue.pending()).toHaveLength(0);
  });

  it("does not duplicate an event that is queued twice", async () => {
    // Idempotency is the whole point of clientEventId: a retry must not create a second
    // sighting of the same pothole.
    await queue.enqueue(payload("a"));
    await queue.enqueue(payload("a"));
    expect(await queue.pending()).toHaveLength(1);
  });

  it("drains oldest first", async () => {
    await queue.enqueue(payload("a"));
    await new Promise((r) => setTimeout(r, 2));
    await queue.enqueue(payload("b"));
    expect((await queue.pending()).map((e) => e.clientEventId)).toEqual(["a", "b"]);
  });

  it("survives being reopened, which is what makes it useful offline", async () => {
    await queue.enqueue(payload("a"));
    queue.close();
    const reopened = await OfflineEventQueue.open(`test-db-${counter}`);
    expect(await reopened.pending()).toHaveLength(1);
  });
});

describe("upload outcomes", () => {
  it("stops offering an event once the server has it", async () => {
    await queue.enqueue(payload("a"));
    await queue.markUploaded("a");
    expect(await queue.pending()).toHaveLength(0);
    expect((await queue.get("a"))?.state).toBe("UPLOADED");
  });

  it("drops the images once uploaded so a drive does not fill storage", async () => {
    await queue.enqueue(payload("a"), { fullImage: "data:x", cropImage: "data:y" });
    await queue.markUploaded("a");
    const row = await queue.get("a");
    expect(row?.fullImage).toBeUndefined();
    expect(row?.cropImage).toBeUndefined();
  });

  it("keeps a failed event queued and counts the attempt", async () => {
    await queue.enqueue(payload("a"));
    await queue.markFailed("a", "network unreachable");
    const row = await queue.get("a");
    expect(row?.state).toBe("UPLOAD_RETRY");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("network unreachable");
    expect(await queue.pending()).toHaveLength(1);
  });

  it("re-queues an already-uploaded event without resetting its state", async () => {
    await queue.enqueue(payload("a"));
    await queue.markUploaded("a");
    await queue.enqueue(payload("a"));
    expect((await queue.get("a"))?.state).toBe("UPLOADED");
  });

  it("reports the backlog", async () => {
    await queue.enqueue(payload("a"));
    await queue.enqueue(payload("b"));
    await queue.enqueue(payload("c"));
    await queue.markUploaded("a");
    await queue.markFailed("b", "boom");
    expect(await queue.counts()).toEqual({ pending: 1, uploaded: 1, failed: 1 });
  });

  it("purges confirmed events but keeps outstanding ones", async () => {
    await queue.enqueue(payload("a"));
    await queue.enqueue(payload("b"));
    await queue.markUploaded("a");
    expect(await queue.purgeUploaded()).toBe(1);
    expect((await queue.all()).map((e) => e.clientEventId)).toEqual(["b"]);
  });
});
