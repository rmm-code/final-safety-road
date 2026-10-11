"use client";

import type { DetectionEventPayload, LocationSource, SeverityLevel } from "@pothole/shared-types";
import type { ImageContentType } from "./image-encoding";
import type { StorageUploadTarget } from "./storage-upload";

/**
 * Typed client for the Pothole Intelligence API.
 *
 * The token lives in memory plus sessionStorage rather than a long-lived cookie: this is
 * an internal console, and a token that survives a closed browser is a token that
 * outlives the person using it.
 */

export type PotholeStatus =
  // Reported by the public and not yet corroborated. Purple on the public map; the
  // weakest claim in the vocabulary, which is why it is listed first.
  | "reported"
  | "active"
  | "suspected_repaired"
  | "repaired"
  | "false_positive"
  | "ignored"
  | "archived";

export type Pothole = {
  id: string;
  latitude: number;
  longitude: number;
  location_accuracy_m: number;
  severity: SeverityLevel;
  severity_score: number;
  status: PotholeStatus;
  first_seen_at: string;
  last_seen_at: string;
  sighting_count: number;
  primary_image_key: string | null;
  road_name: string | null;
  reviewed_at: string | null;
  review_verdict: ReviewVerdict | null;
};

/** An operator's verdict on the detector. Not a status: a correct pothole is still open. */
export type ReviewVerdict = "correct" | "false_positive";

export type PotholeObservation = {
  id: string;
  detected_at: string;
  confidence: number;
  severity: SeverityLevel;
  model_version: string;
  /**
   * Metres. A GPS fix's accuracy, or, for a manual sighting, the radius the operator gave
   * the pin. Never show the second as the first.
   */
  location_accuracy_m: number;
  /** "manual" is a point an operator placed by hand, never a GPS fix. */
  location_source: LocationSource;
  crop_image_key: string | null;
  full_image_key: string | null;
  /** Short-lived signed links; fetch the detail again rather than caching them. */
  crop_image_url: string | null;
  full_image_url: string | null;
};

export type PotholeDetail = Pothole & {
  primary_image_url: string | null;
  observations: PotholeObservation[];
};

export type StatsOverview = {
  active_potholes: number;
  large: number;
  medium: number;
  small: number;
  new_today: number;
  sightings_today: number;
  drive_sessions: number;
  total_sightings: number;
};

export type CitizenReportState = "pending" | "accepted" | "rejected";

export type CitizenReport = {
  id: string;
  pothole_id: string | null;
  source: "telegram_bot" | "telegram_miniapp";
  latitude: number;
  longitude: number;
  location_accuracy_m: number;
  reported_at: string;
  comment: string | null;
  image_url: string | null;
  review_state: CitizenReportState;
  review_note: string | null;
  reviewed_at: string | null;
  telegram_username: string | null;
  pothole_status: PotholeStatus | null;
  pothole_severity: SeverityLevel | null;
};

export type BoundingBox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

export type UploadTarget = StorageUploadTarget;

export type DriveSessionStart = {
  /** Generated on the phone, so a drive started out of signal keeps one identity. */
  id?: string;
  started_at?: string;
  device_name?: string;
  platform?: string;
  browser?: string;
};

export type DetectionAccepted = {
  event: { id: string; client_event_id: string; pothole_id: string | null };
  pothole_id: string;
  deduplicated: boolean;
  created_pothole: boolean;
  already_ingested: boolean;
  full_image_upload: UploadTarget | null;
  crop_image_upload: UploadTarget | null;
};

export type PotholeQuery = {
  bbox: BoundingBox;
  severity?: SeverityLevel[];
  status?: PotholeStatus[];
  minSightings?: number;
  /** true for reviewed only, false for the review queue. */
  reviewed?: boolean;
  /** "severity" puts the worst first. */
  order?: "recent" | "severity";
};

const TOKEN_KEY = "pothole.token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * What a person can do about a failed request, in a sentence.
 *
 * The status decides it. A refused request means the API is up and wants a sign-in, so
 * telling that person to start the server sends them looking for a fault that is not
 * there; only a request that never got an answer means the API is unreachable.
 */
export function failureHint(cause: unknown): string | null {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return "Sign in to see this.";
    if (cause.status === 403) return "This account is not allowed to see this.";
    if (cause.status >= 500) return "The API failed while answering. Its log has the reason.";
    return null;
  }
  return "The API could not be reached. Check that it is running and that this page can reach it.";
}

export function getToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof sessionStorage === "undefined") return;
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
  // Same name as AUTH_CHANGED in ./auth; spelled out to keep this module dependency-free.
  if (typeof window !== "undefined") window.dispatchEvent(new Event("pothole:auth-changed"));
}

export function formatBbox(bbox: BoundingBox): string {
  return [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat]
    .map((value) => value.toFixed(6))
    .join(",");
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = getToken();
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });

    if (!response.ok) {
      // A token the server no longer accepts has expired or been revoked. Dropping it
      // makes the console say "sign in" instead of repeating a refused credential.
      if (response.status === 401 && token) setToken(null);
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { detail?: string };
        if (body.detail) detail = body.detail;
      } catch {
        // Non-JSON error body; the status line is the best we have.
      }
      throw new ApiError(detail, response.status);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async login(email: string, password: string): Promise<string> {
    const body = await this.request<{ access_token: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setToken(body.access_token);
    return body.access_token;
  }

  me() {
    return this.request<{ id: string; email: string; name: string; role: string }>("/api/v1/auth/me");
  }

  potholes(query: PotholeQuery): Promise<Pothole[]> {
    const params = new URLSearchParams({ bbox: formatBbox(query.bbox) });
    if (query.severity?.length) params.set("severity", query.severity.join(","));
    if (query.status?.length) params.set("status", query.status.join(","));
    if (query.minSightings) params.set("min_sightings", String(query.minSightings));
    if (query.reviewed !== undefined) params.set("reviewed", String(query.reviewed));
    if (query.order) params.set("order", query.order);
    return this.request<Pothole[]>(`/api/v1/potholes?${params.toString()}`);
  }

  pothole(id: string): Promise<PotholeDetail> {
    return this.request<PotholeDetail>(`/api/v1/potholes/${id}`);
  }

  /** Record whether the detector was right. Takes the pothole out of the review queue. */
  reviewPothole(id: string, verdict: ReviewVerdict, note?: string): Promise<Pothole> {
    return this.request<Pothole>(`/api/v1/potholes/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ verdict, ...(note ? { note } : {}) }),
    });
  }

  setPotholeStatus(id: string, status: PotholeStatus, reason?: string): Promise<Pothole> {
    return this.request<Pothole>(`/api/v1/potholes/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status, ...(reason ? { reason } : {}) }),
    });
  }

  /**
   * Reports from the public awaiting an operator.
   *
   * Their photos are held back from the public map until one is accepted: a bot open to
   * anyone accepts images from anyone, and publishing them unseen would make the map a
   * channel for whatever people chose to upload.
   */
  citizenReports(reviewState: CitizenReportState | "all" = "pending"): Promise<CitizenReport[]> {
    const params = new URLSearchParams();
    if (reviewState !== "all") params.set("review_state", reviewState);
    return this.request<CitizenReport[]>(`/api/v1/citizen-reports?${params.toString()}`);
  }

  reviewCitizenReport(
    id: string,
    state: Exclude<CitizenReportState, "pending">,
    note?: string,
  ): Promise<CitizenReport> {
    return this.request<CitizenReport>(`/api/v1/citizen-reports/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ state, ...(note ? { note } : {}) }),
    });
  }

  citizenReportsPending(): Promise<{ pending: number }> {
    return this.request<{ pending: number }>("/api/v1/citizen-reports/pending-count");
  }

  stats(): Promise<StatsOverview> {
    return this.request<StatsOverview>("/api/v1/stats/overview");
  }

  /**
   * Upload one sighting.
   *
   * Idempotent on `clientEventId`: a retry after an ambiguous failure returns the
   * original event rather than creating a second pothole.
   */
  createDetection(
    payload: DetectionEventPayload,
    imageContentType?: ImageContentType,
  ): Promise<DetectionAccepted> {
    // The upload forms are signed for this type, so it must be the type actually encoded.
    const query = imageContentType
      ? `?${new URLSearchParams({ image_content_type: imageContentType }).toString()}`
      : "";
    return this.request<DetectionAccepted>(`/api/v1/detections${query}`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /** Idempotent on `id`: creating a session that already exists returns it. */
  createDriveSession(start: DriveSessionStart = {}) {
    return this.request<{ id: string }>("/api/v1/drive-sessions", {
      method: "POST",
      body: JSON.stringify(start),
    });
  }

  endDriveSession(id: string, endedAt?: string) {
    return this.request<{ id: string; status: string }>(`/api/v1/drive-sessions/${id}/end`, {
      method: "POST",
      ...(endedAt ? { body: JSON.stringify({ ended_at: endedAt }) } : {}),
    });
  }
}

export function createApiClient(baseUrl: string): ApiClient {
  return new ApiClient(baseUrl.replace(/\/$/, ""));
}
