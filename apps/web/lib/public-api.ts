"use client";

import type { SeverityLevel } from "@pothole/shared-types";
import type { StorageUploadTarget } from "./storage-upload";

/**
 * Client for the unauthenticated public map, and for the Mini App that reports into it.
 *
 * Separate from `api-client.ts` on purpose. That one carries an operator's bearer token
 * and speaks the internal vocabulary; this one holds no credentials at all, and the only
 * identity it ever sends is Telegram's signed `initData` - which the API verifies, and
 * which a browser outside Telegram simply does not have.
 */

/**
 * The three states the public map draws. Mirrors `PUBLIC_STATE_BY_STATUS` in
 * `apps/api/app/schemas/public.py`, which is where internal statuses are translated.
 * Internal status names deliberately never reach this client.
 */
export type PublicState = "unverified" | "confirmed" | "fixed";

export type PublicPothole = {
  id: string;
  latitude: number;
  longitude: number;
  state: PublicState;
  severity: SeverityLevel;
  reported_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

export type PublicPotholeDetail = PublicPothole & {
  location_accuracy_m: number;
  comment: string | null;
  image_url: string | null;
};

export type PublicCounts = {
  unverified: number;
  confirmed: number;
  fixed: number;
  total: number;
};

export type PublicConfig = {
  report_url: string;
  bot_username: string;
  confirmations_required: number;
  telegram_enabled: boolean;
};

export type BoundingBox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

export type ReportSubmission = {
  client_report_id: string;
  latitude: number;
  longitude: number;
  location_accuracy_m?: number | null;
  comment?: string | null;
};

/** A signed POST form for one photo; see `uploadToStorage`. */
export type UploadTarget = StorageUploadTarget;

export type ReportAccepted = {
  id: string;
  pothole_id: string;
  latitude: number;
  longitude: number;
  status: string;
  created_pothole: boolean;
  deduplicated: boolean;
  already_reported: boolean;
  verified_now: boolean;
  distinct_reporters: number;
  confirmations_required: number;
  sighting_count: number;
  image_upload: UploadTarget | null;
};

function bboxParam(bbox: BoundingBox): string {
  return [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat].join(",");
}

export class PublicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

export function createPublicApiClient(baseUrl: string, initData?: () => string | null) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("Content-Type", "application/json");
    // Only ever the signature Telegram issued. There is no fallback identity: a report
    // that cannot prove who sent it is a report that cannot be counted or moderated.
    const signature = initData?.();
    if (signature) headers.set("X-Telegram-Init-Data", signature);

    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new PublicApiError(detail || `${response.status} ${response.statusText}`, response.status);
    }
    return (await response.json()) as T;
  }

  return {
    config: () => request<PublicConfig>("/api/v1/public/config"),

    potholes: (bbox: BoundingBox, state?: PublicState[]) => {
      const params = new URLSearchParams({ bbox: bboxParam(bbox) });
      if (state?.length) params.set("state", state.join(","));
      return request<PublicPothole[]>(`/api/v1/public/potholes?${params}`);
    },

    counts: (bbox: BoundingBox) =>
      request<PublicCounts>(`/api/v1/public/counts?${new URLSearchParams({ bbox: bboxParam(bbox) })}`),

    pothole: (id: string) => request<PublicPotholeDetail>(`/api/v1/public/potholes/${id}`),

    submitReport: (body: ReportSubmission) =>
      request<ReportAccepted>("/api/v1/citizen-reports", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  };
}

export type PublicApiClient = ReturnType<typeof createPublicApiClient>;
