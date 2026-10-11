import type { DetectionEventPayload } from "@pothole/shared-types";

/**
 * Durable queue of pothole events waiting to reach the server.
 *
 * Driving is exactly where connectivity fails, and an event that only exists in memory is
 * lost when the tab is backgrounded or the phone drops the page. Events are therefore
 * written to IndexedDB the moment they are built, and uploaded whenever the network
 * allows.
 *
 * `clientEventId` is the primary key, which makes the whole pipeline idempotent: a retry
 * after an ambiguous failure re-queues the same row rather than creating a second
 * sighting of the same pothole.
 */
export type QueuedEventState = "PENDING_UPLOAD" | "UPLOAD_RETRY" | "UPLOADED";

export type QueuedEvent = {
  clientEventId: string;
  payload: DetectionEventPayload;
  /** Evidence images as data URLs. Only the best frame is kept, never the video. */
  fullImage?: string;
  cropImage?: string;
  state: QueuedEventState;
  attempts: number;
  queuedAt: number;
  lastError?: string;
};

export type QueueCounts = {
  pending: number;
  uploaded: number;
  failed: number;
};

/**
 * A drive, held on the phone until the server has both its start and its end.
 *
 * The id is generated here, so a drive started out of signal is still one drive: every
 * sighting carries this id from the first frame, and the session is created on the
 * server whenever the phone next reaches it. Before this existed, a drive begun in a
 * dead spot stamped its sightings with an id the server had never seen, and every one of
 * them was rejected as "Drive session not found" - and discarded.
 */
export type QueuedSession = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  device: { device_name?: string; platform?: string; browser?: string };
  /** The server has confirmed the session exists. */
  created: boolean;
  /** The server has recorded the end. */
  ended: boolean;
};

const DB_NAME = "pothole-intelligence";
// 2 adds the `sessions` store. Upgrading keeps every queued event.
const DB_VERSION = 2;
const STORE = "events";
const SESSIONS = "sessions";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export class OfflineEventQueue {
  private constructor(private readonly db: IDBDatabase) {}

  static isSupported(): boolean {
    return typeof indexedDB !== "undefined";
  }

  static open(dbName = DB_NAME): Promise<OfflineEventQueue> {
    if (!OfflineEventQueue.isSupported()) {
      return Promise.reject(new Error("IndexedDB is unavailable; events cannot be queued."));
    }
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "clientEventId" });
          store.createIndex("state", "state", { unique: false });
        }
        if (!db.objectStoreNames.contains(SESSIONS)) {
          db.createObjectStore(SESSIONS, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(new OfflineEventQueue(request.result));
      request.onerror = () => reject(request.error ?? new Error("Could not open the event queue"));
    });
  }

  /**
   * Store an event. Re-enqueuing the same id updates the row rather than duplicating it.
   *
   * Synthetic events are never stored, so they can never be uploaded: `auto` falls back to
   * the mock engine whenever the model fails to load, and its fabricated boxes would sit on
   * the map at real GPS positions. Synthetic engines carry a "mock-" model version
   * (`VisionEngineInfo.modelVersion`); the API refuses them too.
   */
  async enqueue(
    payload: DetectionEventPayload,
    images?: { fullImage?: string; cropImage?: string },
  ): Promise<QueuedEvent | null> {
    if (payload.modelVersion.startsWith("mock-")) return null;
    const existing = await this.get(payload.clientEventId);
    const record: QueuedEvent = {
      clientEventId: payload.clientEventId,
      payload,
      state: existing?.state === "UPLOADED" ? "UPLOADED" : "PENDING_UPLOAD",
      attempts: existing?.attempts ?? 0,
      queuedAt: existing?.queuedAt ?? Date.now(),
      ...(images?.fullImage ? { fullImage: images.fullImage } : {}),
      ...(images?.cropImage ? { cropImage: images.cropImage } : {}),
    };
    await this.put(record);
    return record;
  }

  async get(clientEventId: string): Promise<QueuedEvent | undefined> {
    const tx = this.db.transaction(STORE, "readonly");
    return requestToPromise(tx.objectStore(STORE).get(clientEventId) as IDBRequest<QueuedEvent>);
  }

  async all(): Promise<QueuedEvent[]> {
    const tx = this.db.transaction(STORE, "readonly");
    const rows = await requestToPromise(
      tx.objectStore(STORE).getAll() as IDBRequest<QueuedEvent[]>,
    );
    return rows.sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Events still needing upload, oldest first, so the backlog drains in order. */
  async pending(limit = 25): Promise<QueuedEvent[]> {
    const rows = await this.all();
    return rows.filter((row) => row.state !== "UPLOADED").slice(0, limit);
  }

  async markUploaded(clientEventId: string): Promise<void> {
    const row = await this.get(clientEventId);
    if (!row) return;
    // Images are dropped once the server has them: a phone should not hold evidence
    // frames for a whole drive. Any recorded error is kept, because this is also how a
    // permanently rejected event leaves the queue and the reason is the only trace of it.
    await this.put({
      clientEventId: row.clientEventId,
      payload: row.payload,
      state: "UPLOADED",
      attempts: row.attempts,
      queuedAt: row.queuedAt,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    });
  }

  async markFailed(clientEventId: string, error: string): Promise<void> {
    const row = await this.get(clientEventId);
    if (!row) return;
    await this.put({ ...row, state: "UPLOAD_RETRY", attempts: row.attempts + 1, lastError: error });
  }

  async counts(): Promise<QueueCounts> {
    const rows = await this.all();
    return {
      pending: rows.filter((r) => r.state === "PENDING_UPLOAD").length,
      uploaded: rows.filter((r) => r.state === "UPLOADED").length,
      failed: rows.filter((r) => r.state === "UPLOAD_RETRY").length,
    };
  }

  /** Drop rows the server has confirmed, keeping the database small across drives. */
  async purgeUploaded(): Promise<number> {
    const rows = await this.all();
    const uploaded = rows.filter((r) => r.state === "UPLOADED");
    for (const row of uploaded) await this.delete(row.clientEventId);
    return uploaded.length;
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([STORE, SESSIONS], "readwrite");
    await Promise.all([
      requestToPromise(tx.objectStore(STORE).clear()),
      requestToPromise(tx.objectStore(SESSIONS).clear()),
    ]);
  }

  /** Record a drive the moment it starts, before the server has heard of it. */
  async startSession(
    id: string,
    device: QueuedSession["device"],
    startedAt = new Date().toISOString(),
  ): Promise<QueuedSession> {
    const existing = await this.getSession(id);
    if (existing) return existing;
    const session: QueuedSession = {
      id,
      startedAt,
      endedAt: null,
      device,
      created: false,
      ended: false,
    };
    await this.putSession(session);
    return session;
  }

  async endSession(id: string, endedAt = new Date().toISOString()): Promise<void> {
    const session = await this.getSession(id);
    if (!session || session.endedAt) return;
    await this.putSession({ ...session, endedAt });
  }

  async getSession(id: string): Promise<QueuedSession | undefined> {
    const tx = this.db.transaction(SESSIONS, "readonly");
    return requestToPromise(tx.objectStore(SESSIONS).get(id) as IDBRequest<QueuedSession>);
  }

  async sessions(): Promise<QueuedSession[]> {
    const tx = this.db.transaction(SESSIONS, "readonly");
    const rows = await requestToPromise(
      tx.objectStore(SESSIONS).getAll() as IDBRequest<QueuedSession[]>,
    );
    return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async markSessionCreated(id: string): Promise<void> {
    const session = await this.getSession(id);
    if (session && !session.created) await this.putSession({ ...session, created: true });
  }

  /** The end is recorded, so nothing about this drive is left to send. */
  async markSessionEnded(id: string): Promise<void> {
    const tx = this.db.transaction(SESSIONS, "readwrite");
    await requestToPromise(tx.objectStore(SESSIONS).delete(id));
  }

  close(): void {
    this.db.close();
  }

  private put(record: QueuedEvent): Promise<IDBValidKey> {
    const tx = this.db.transaction(STORE, "readwrite");
    return requestToPromise(tx.objectStore(STORE).put(record));
  }

  private putSession(session: QueuedSession): Promise<IDBValidKey> {
    const tx = this.db.transaction(SESSIONS, "readwrite");
    return requestToPromise(tx.objectStore(SESSIONS).put(session));
  }

  private delete(clientEventId: string): Promise<undefined> {
    const tx = this.db.transaction(STORE, "readwrite");
    return requestToPromise(tx.objectStore(STORE).delete(clientEventId));
  }
}
