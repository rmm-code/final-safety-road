"use client";

import type { DetectionEventPayload } from "@pothole/shared-types";
import { ApiError, type ApiClient } from "./api-client";
import { imageContentType, type ImageContentType } from "./image-encoding";
import type { OfflineEventQueue, QueuedEvent, QueuedSession } from "./offline-queue";
import { uploadToStorage } from "./storage-upload";

/**
 * Drains queued pothole events to the server.
 *
 * The queue exists because driving is exactly where connectivity fails. This is the other
 * half: something that empties it whenever the network allows, and leaves it alone when
 * it does not.
 *
 * Five rules shape the behaviour:
 *
 * 1. A failed upload is retried, never dropped. The event survives in IndexedDB.
 * 2. A drive's session is created on the server before its sightings are sent, and ended
 *    after them, both from the queue - so a drive started or stopped out of signal still
 *    arrives whole.
 * 3. "Not signed in" stops the drain and keeps everything. 401 and 403 are 4xx, but they
 *    describe the phone, not the sighting: the same event succeeds once someone signs in.
 * 4. Any other rejection is NOT retried. The server will never accept that payload, and
 *    retrying it forever would block everything queued behind it.
 * 5. Images are uploaded after the event, straight to object storage, and a failure there
 *    does not fail the sighting. A pothole recorded without its photo is worth far more
 *    than no pothole at all.
 */
export type UploadOutcome = {
  uploaded: number;
  failed: number;
  skipped: number;
  /** Why the drain stopped early, if it did. Nothing was discarded. */
  blocked: "auth" | null;
};

export type UploaderOptions = {
  client: ApiClient;
  queue: OfflineEventQueue;
  /** Most events to attempt per drain. Keeps a backlog from monopolising the network. */
  batchSize?: number;
  onProgress?: (outcome: UploadOutcome) => void;
  fetchImpl?: typeof fetch;
};

type SendResult = "uploaded" | "failed" | "skipped" | "blocked";

/** The phone is not allowed to upload - yet. Signing in fixes it; the data is fine. */
function isAuthFailure(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** The detections endpoint answers 404 for exactly one reason: an unknown drive session. */
function isMissingSession(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** A 4xx other than 429 will never succeed on retry. */
function isPermanentRejection(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

class AuthBlocked extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postImage(
  target: NonNullable<Awaited<ReturnType<ApiClient["createDetection"]>>["full_image_upload"]>,
  dataUrl: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const blob = await (await fetchImpl(dataUrl)).blob();
  await uploadToStorage(target, blob, fetchImpl);
}

export class EventUploader {
  private readonly options: UploaderOptions;
  private draining = false;

  constructor(options: UploaderOptions) {
    this.options = options;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /**
   * Attempt to upload the pending backlog.
   *
   * Safe to call often - concurrent calls collapse into one, so a reconnect event and a
   * timer tick cannot upload the same sighting twice.
   */
  async drain(): Promise<UploadOutcome> {
    const outcome: UploadOutcome = { uploaded: 0, failed: 0, skipped: 0, blocked: null };
    if (this.draining) return outcome;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return outcome;

    this.draining = true;
    try {
      await this.createSessions();

      const pending = await this.options.queue.pending(this.options.batchSize ?? 10);
      for (const row of pending) {
        const result = await this.send(row);
        if (result === "blocked") throw new AuthBlocked();
        outcome[result] += 1;
        this.options.onProgress?.({ ...outcome });
      }

      await this.endSessions();
    } catch (cause) {
      if (!(cause instanceof AuthBlocked)) throw cause;
      outcome.blocked = "auth";
    } finally {
      this.draining = false;
    }

    return outcome;
  }

  /** Every drive the server has not confirmed yet. Idempotent on the phone's id. */
  private async createSessions(): Promise<void> {
    for (const session of await this.options.queue.sessions()) {
      if (session.created) continue;
      try {
        await this.createSession(session.id, session);
      } catch (cause) {
        if (isAuthFailure(cause)) throw new AuthBlocked();
        // Unreachable, or a server error: the events will fail the same way and the next
        // drain tries again. Never fatal to the drain.
      }
    }
  }

  private async createSession(id: string, session?: QueuedSession): Promise<void> {
    await this.options.client.createDriveSession({
      id,
      ...(session ? { started_at: session.startedAt, ...session.device } : {}),
    });
    await this.options.queue.markSessionCreated(id);
  }

  /** Ends are sent after the sightings, so a session is never closed under its own data. */
  private async endSessions(): Promise<void> {
    const queue = this.options.queue;
    const pendingIds = new Set((await queue.pending(Number.MAX_SAFE_INTEGER)).map((row) => row.payload.driveSessionId));
    for (const session of await queue.sessions()) {
      if (!session.created || !session.endedAt || pendingIds.has(session.id)) continue;
      try {
        await this.options.client.endDriveSession(session.id, session.endedAt);
        await queue.markSessionEnded(session.id);
      } catch (cause) {
        if (isAuthFailure(cause)) throw new AuthBlocked();
        if (isPermanentRejection(cause)) await queue.markSessionEnded(session.id);
      }
    }
  }

  private async send(row: QueuedEvent): Promise<SendResult> {
    try {
      return await this.upload(row);
    } catch (cause) {
      if (isAuthFailure(cause)) {
        // Kept exactly as it is: the next drain after a sign-in sends it.
        await this.options.queue.markFailed(row.clientEventId, `Sign in to upload: ${messageOf(cause)}`);
        return "blocked";
      }
      if (isMissingSession(cause)) {
        // A session this phone never managed to create, or one from before sessions were
        // queued. Create it under the id the sighting already carries, then send again.
        try {
          await this.createSession(row.payload.driveSessionId, await this.options.queue.getSession(row.payload.driveSessionId));
          return await this.upload(row);
        } catch (retryCause) {
          return this.reject(row, retryCause);
        }
      }
      return this.reject(row, cause);
    }
  }

  private async reject(row: QueuedEvent, cause: unknown): Promise<SendResult> {
    if (isAuthFailure(cause)) {
      await this.options.queue.markFailed(row.clientEventId, `Sign in to upload: ${messageOf(cause)}`);
      return "blocked";
    }
    if (isPermanentRejection(cause)) {
      // The server will never accept this. Mark it done so it stops blocking the queue,
      // and keep the reason for whoever investigates.
      await this.options.queue.markFailed(row.clientEventId, `Rejected: ${messageOf(cause)}`);
      await this.options.queue.markUploaded(row.clientEventId);
      return "skipped";
    }
    await this.options.queue.markFailed(row.clientEventId, messageOf(cause));
    return "failed";
  }

  private async upload(row: QueuedEvent): Promise<SendResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    // Signed for the type actually encoded. Safari may not encode WebP, and a row queued
    // before the fallback existed says what it really holds in its data URL.
    const contentType = eventImageType(row);
    const accepted = await this.options.client.createDetection(row.payload, contentType);

    await Promise.allSettled([
      row.fullImage && accepted.full_image_upload && imageContentType(row.fullImage) === contentType
        ? postImage(accepted.full_image_upload, row.fullImage, fetchImpl)
        : Promise.resolve(),
      row.cropImage && accepted.crop_image_upload && imageContentType(row.cropImage) === contentType
        ? postImage(accepted.crop_image_upload, row.cropImage, fetchImpl)
        : Promise.resolve(),
    ]);

    await this.options.queue.markUploaded(row.clientEventId);
    return "uploaded";
  }
}

/** One type per event, because the API signs both images for one type. */
function eventImageType(row: QueuedEvent): ImageContentType | undefined {
  const source = row.fullImage ?? row.cropImage;
  return source ? imageContentType(source) : undefined;
}

export type { DetectionEventPayload };
