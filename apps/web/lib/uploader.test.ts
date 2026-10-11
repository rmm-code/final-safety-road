import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectionEventPayload } from "@pothole/shared-types";
import { ApiError } from "./api-client";
import { OfflineEventQueue } from "./offline-queue";
import { EventUploader } from "./uploader";

function payload(id: string, driveSessionId = "session-1"): DetectionEventPayload {
  return {
    clientEventId: id,
    driveSessionId,
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
    modelVersion: "pothole-road-anomaly-1.0.0",
  };
}

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    event: { id: "e1", client_event_id: "a", pothole_id: "p1" },
    pothole_id: "p1",
    deduplicated: false,
    created_pothole: true,
    already_ingested: false,
    full_image_upload: null,
    crop_image_upload: null,
    ...overrides,
  };
}

function form(url: string) {
  return {
    key: "k",
    url,
    fields: { key: "k", "Content-Type": "image/webp", policy: "p" },
    method: "POST",
    expires_in_seconds: 900,
  };
}

type FakeClient = Partial<{
  createDetection: unknown;
  createDriveSession: unknown;
  endDriveSession: unknown;
}>;

let queue: OfflineEventQueue;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  queue = await OfflineEventQueue.open(`uploader-db-${counter}`);
  vi.stubGlobal("navigator", { onLine: true });
});

function uploader(client: FakeClient, fetchImpl?: typeof fetch) {
  return new EventUploader({
    client: {
      createDriveSession: vi.fn(async () => ({ id: "session-1" })),
      endDriveSession: vi.fn(async () => ({ id: "session-1", status: "ended" })),
      ...client,
    } as never,
    queue,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

describe("draining the queue", () => {
  it("uploads a pending event and stops offering it", async () => {
    const createDetection = vi.fn(async () => accepted());
    await queue.enqueue(payload("a"));

    const outcome = await uploader({ createDetection }).drain();

    expect(outcome.uploaded).toBe(1);
    expect(createDetection).toHaveBeenCalledTimes(1);
    expect(await queue.pending()).toHaveLength(0);
  });

  it("keeps a failed event queued for the next attempt", async () => {
    const createDetection = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    await queue.enqueue(payload("a"));

    const outcome = await uploader({ createDetection }).drain();

    expect(outcome.failed).toBe(1);
    // Losing a sighting because a tunnel dropped the signal is the failure to avoid.
    expect(await queue.pending()).toHaveLength(1);
    expect((await queue.get("a"))?.attempts).toBe(1);
  });

  it("stops retrying an event the server will never accept", async () => {
    const createDetection = vi.fn(async () => {
      throw new ApiError("Field required", 422);
    });
    await queue.enqueue(payload("a"));

    const outcome = await uploader({ createDetection }).drain();

    expect(outcome.skipped).toBe(1);
    // A 4xx retried forever would block everything queued behind it.
    expect(await queue.pending()).toHaveLength(0);
    expect((await queue.get("a"))?.lastError).toContain("Rejected");
  });

  it("does retry a server error, which may be transient", async () => {
    const createDetection = vi.fn(async () => {
      throw new ApiError("Bad gateway", 502);
    });
    await queue.enqueue(payload("a"));

    await uploader({ createDetection }).drain();
    expect(await queue.pending()).toHaveLength(1);
  });

  it("does nothing at all while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const createDetection = vi.fn(async () => accepted());
    await queue.enqueue(payload("a"));

    const outcome = await uploader({ createDetection }).drain();

    expect(createDetection).not.toHaveBeenCalled();
    expect(outcome.uploaded).toBe(0);
    expect(await queue.pending()).toHaveLength(1);
  });

  it("collapses concurrent drains so a sighting is never sent twice", async () => {
    const createDetection = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return accepted();
    });
    await queue.enqueue(payload("a"));

    const instance = uploader({ createDetection });
    const [first, second] = await Promise.all([instance.drain(), instance.drain()]);

    expect(createDetection).toHaveBeenCalledTimes(1);
    expect(first.uploaded + second.uploaded).toBe(1);
  });

  it("respects the batch size so a backlog does not monopolise the network", async () => {
    const createDetection = vi.fn(async () => accepted());
    for (const id of ["a", "b", "c", "d"]) await queue.enqueue(payload(id));

    const instance = new EventUploader({
      client: { createDetection, createDriveSession: vi.fn() } as never,
      queue,
      batchSize: 2,
    });
    const outcome = await instance.drain();

    expect(outcome.uploaded).toBe(2);
    expect(await queue.pending()).toHaveLength(2);
  });
});

describe("not signed in", () => {
  it("keeps every event when the server asks for a sign-in", async () => {
    // A 401 describes the phone, not the sighting. Treating it like any other 4xx used to
    // discard every pothole of a drive made without a token.
    const createDetection = vi.fn(async () => {
      throw new ApiError("Authentication required", 401);
    });
    for (const id of ["a", "b", "c"]) await queue.enqueue(payload(id));

    const outcome = await uploader({ createDetection }).drain();

    expect(outcome.blocked).toBe("auth");
    expect(outcome.skipped).toBe(0);
    expect(await queue.pending()).toHaveLength(3);
    // Stops at the first refusal: the rest would be refused the same way.
    expect(createDetection).toHaveBeenCalledTimes(1);
    expect((await queue.get("a"))?.lastError).toContain("Sign in");
  });

  it("treats a forbidden account the same way", async () => {
    const createDetection = vi.fn(async () => {
      throw new ApiError("Insufficient role", 403);
    });
    await queue.enqueue(payload("a"));

    const outcome = await uploader({ createDetection }).drain();

    expect(outcome.blocked).toBe("auth");
    expect(await queue.pending()).toHaveLength(1);
  });

  it("sends the kept events once the sign-in succeeds", async () => {
    let signedIn = false;
    const createDetection = vi.fn(async () => {
      if (!signedIn) throw new ApiError("Authentication required", 401);
      return accepted();
    });
    await queue.enqueue(payload("a"));
    const instance = uploader({ createDetection });

    await instance.drain();
    signedIn = true;
    const outcome = await instance.drain();

    expect(outcome.uploaded).toBe(1);
    expect(await queue.pending()).toHaveLength(0);
  });
});

describe("drive sessions", () => {
  it("creates a queued session before sending its sightings", async () => {
    const calls: string[] = [];
    const createDriveSession = vi.fn(async (start: { id: string }) => {
      calls.push(`session:${start.id}`);
      return { id: start.id };
    });
    const createDetection = vi.fn(async (event: DetectionEventPayload) => {
      calls.push(`event:${event.clientEventId}`);
      return accepted();
    });
    await queue.startSession("drive-1", { device_name: "iPhone" }, "2026-10-10T08:00:00.000Z");
    await queue.enqueue(payload("a", "drive-1"));

    await uploader({ createDetection, createDriveSession }).drain();

    expect(calls).toEqual(["session:drive-1", "event:a"]);
    expect(createDriveSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "drive-1", started_at: "2026-10-10T08:00:00.000Z", device_name: "iPhone" }),
    );
    expect((await queue.getSession("drive-1"))?.created).toBe(true);
  });

  it("creates a session the server has never seen, then sends the sighting again", async () => {
    // A drive started out of signal: its sightings carry an id the server lacks.
    let sessionExists = false;
    const createDriveSession = vi.fn(async () => {
      sessionExists = true;
      return { id: "drive-2" };
    });
    const createDetection = vi.fn(async () => {
      if (!sessionExists) throw new ApiError("Drive session not found", 404);
      return accepted();
    });
    await queue.enqueue(payload("a", "drive-2"));

    const outcome = await uploader({ createDetection, createDriveSession }).drain();

    expect(outcome.uploaded).toBe(1);
    expect(createDriveSession).toHaveBeenCalledWith(expect.objectContaining({ id: "drive-2" }));
    expect(createDetection).toHaveBeenCalledTimes(2);
  });

  it("ends a drive only after its sightings have gone", async () => {
    const endDriveSession = vi.fn(async () => ({ id: "drive-3", status: "ended" }));
    const createDetection = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    await queue.startSession("drive-3", {}, "2026-10-10T08:00:00.000Z");
    await queue.enqueue(payload("a", "drive-3"));
    await queue.endSession("drive-3", "2026-10-10T08:40:00.000Z");

    await uploader({ createDetection, endDriveSession }).drain();
    expect(endDriveSession).not.toHaveBeenCalled();

    const working = vi.fn(async () => accepted());
    await uploader({ createDetection: working, endDriveSession }).drain();
    expect(endDriveSession).toHaveBeenCalledWith("drive-3", "2026-10-10T08:40:00.000Z");
    expect(await queue.getSession("drive-3")).toBeUndefined();
  });

  it("keeps a session whose creation could not reach the server", async () => {
    const createDriveSession = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    await queue.startSession("drive-4", {});

    await uploader({ createDetection: vi.fn(), createDriveSession }).drain();

    expect((await queue.getSession("drive-4"))?.created).toBe(false);
  });
});

describe("evidence images", () => {
  function storage() {
    const posts: { url: string; fileLast: boolean }[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = init.body as FormData;
        const names = [...body.keys()];
        posts.push({ url: String(url), fileLast: names[names.length - 1] === "file" });
        return new Response(null, { status: 204 });
      }
      const type = String(url).slice(5, String(url).indexOf(";"));
      return new Response(new Blob(["x"], { type }), { status: 200 });
    }) as unknown as typeof fetch;
    return { posts, fetchImpl };
  }

  it("posts each image to the signed form the server returned, file last", async () => {
    const { posts, fetchImpl } = storage();
    const createDetection = vi.fn(async () =>
      accepted({ full_image_upload: form("https://s3/full"), crop_image_upload: form("https://s3/crop") }),
    );
    await queue.enqueue(payload("a"), {
      fullImage: "data:image/webp;base64,AA",
      cropImage: "data:image/webp;base64,BB",
    });

    await uploader({ createDetection }, fetchImpl).drain();

    expect(posts.map((post) => post.url).sort()).toEqual(["https://s3/crop", "https://s3/full"]);
    // Storage ignores any field after the file, including the signature.
    expect(posts.every((post) => post.fileLast)).toBe(true);
  });

  it("asks for uploads signed for the type the image really is", async () => {
    // Safari may hand back JPEG when asked for WebP. Signing "webp" for it fails.
    const { fetchImpl } = storage();
    const createDetection = vi.fn(async () => accepted());
    await queue.enqueue(payload("a"), { fullImage: "data:image/jpeg;base64,AA" });

    await uploader({ createDetection }, fetchImpl).drain();

    expect(createDetection).toHaveBeenCalledWith(expect.anything(), "image/jpeg");
  });

  it("keeps the sighting when only the image upload fails", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(null, { status: 500 });
      return new Response(new Blob(["x"], { type: "image/webp" }), { status: 200 });
    }) as unknown as typeof fetch;

    const createDetection = vi.fn(async () => accepted({ crop_image_upload: form("https://s3/crop") }));
    await queue.enqueue(payload("a"), { cropImage: "data:image/webp;base64,BB" });

    const outcome = await uploader({ createDetection }, fetchImpl).drain();

    // A pothole recorded without its photo is worth far more than no pothole at all.
    expect(outcome.uploaded).toBe(1);
    expect(await queue.pending()).toHaveLength(0);
  });
});
