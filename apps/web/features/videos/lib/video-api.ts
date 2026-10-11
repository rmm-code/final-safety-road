"use client";

import type { SeverityLevel } from "@pothole/shared-types";
import { getToken } from "@/lib/api-client";
import { uploadToStorage, type StorageUploadTarget } from "@/lib/storage-upload";
import type { SampledFrame, VideoAnalysisResult } from "@/features/analyze/lib/analyse-video";

/** Saved analyses, as the API serves them (/api/v1/video-analyses). */
export type VideoLocation = { latitude: number; longitude: number; accuracyM: number; label: string | null };

export type VideoAnalysisSummary = {
  id: string;
  title: string;
  fileName: string;
  source: "demo" | "upload";
  createdAt: string;
  recordedAt: string | null;
  durationSeconds: number;
  posterUrl: string | null;
  potholeCount: number;
  severityCounts: Record<SeverityLevel, number>;
  location: VideoLocation | null;
  modelVersion: string;
  confidenceThreshold: number;
};

export type VideoPothole = {
  id: string;
  trackId: string;
  firstSeenSeconds: number;
  lastSeenSeconds: number;
  bestFrameSeconds: number | null;
  confidence: number;
  severity: SeverityLevel;
  severityScore: number;
  severityConfidence: number;
  observationCount: number;
  maxArea: number;
  cropUrl: string | null;
  fullUrl: string | null;
};

export type VideoAnalysisDetail = VideoAnalysisSummary & {
  videoUrl: string | null;
  overlayUrl: string | null;
  width: number;
  height: number;
  sampleFps: number;
  framesAnalysed: number;
  rawDetections: number;
  rejectedTracks: number;
  averageInferenceMs: number;
  potholes: VideoPothole[];
};

export type GalleryPothole = VideoPothole & { analysisId: string; analysisTitle: string; located: boolean };

export type LocatedVideo = {
  id: string;
  title: string;
  latitude: number;
  longitude: number;
  accuracyM: number;
  label: string | null;
  potholeCount: number;
  posterUrl: string | null;
  thumbnails: string[];
};

type Uploads = {
  overlay: StorageUploadTarget | null;
  poster: StorageUploadTarget | null;
  video: StorageUploadTarget | null;
  potholes: Record<string, { crop: StorageUploadTarget | null; full: StorageUploadTarget | null }>;
};

const ROOT = "/api/v1";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const response = await fetch(`${ROOT}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const error = new Error(`${init?.method ?? "GET"} ${path} answered ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

export async function listVideoAnalyses(): Promise<VideoAnalysisSummary[]> {
  return (await call<{ items: VideoAnalysisSummary[] }>("/video-analyses")).items;
}

/** The saved analysis, or null when nothing is saved under that id yet. */
export async function getVideoAnalysis(id: string): Promise<VideoAnalysisDetail | null> {
  try {
    return await call<VideoAnalysisDetail>(`/video-analyses/${id}`);
  } catch (cause) {
    if ((cause as { status?: number }).status === 404) return null;
    throw cause;
  }
}

export async function listVideoPotholes(limit = 60, offset = 0): Promise<{ items: GalleryPothole[]; total: number }> {
  return call(`/video-potholes?limit=${limit}&offset=${offset}`);
}

export async function listLocatedVideos(bbox: string): Promise<LocatedVideo[]> {
  return (await call<{ items: LocatedVideo[] }>(`/video-analyses/located?bbox=${encodeURIComponent(bbox)}`)).items;
}

export async function placeVideo(id: string, location: Omit<VideoLocation, "label"> & { label?: string }) {
  return call<VideoAnalysisDetail>(`/video-analyses/${id}/location`, { method: "PUT", body: JSON.stringify(location) });
}

export async function loadOverlay(url: string | null): Promise<SampledFrame[]> {
  if (!url) return [];
  const response = await fetch(url);
  return response.ok ? ((await response.json()) as SampledFrame[]) : [];
}

/** A hand-placed pin stands for a stretch of road, not a point. */
export const HAND_PLACED_ACCURACY_M = 100;

/** The largest video the server takes; Cloudflare refuses bodies over 100 MB. */
export const MAX_VIDEO_BYTES = 95 * 1024 * 1024;

async function dataUrlBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

/**
 * Save a finished analysis for everyone: the record first, then the overlay and photos
 * straight to storage, the video last. A failed upload never loses the analysis: the record
 * says what arrived, and the page shows "video not stored" rather than a broken player.
 */
export async function saveAnalysis({
  id,
  result,
  title,
  fileName,
  demo,
  file,
  recordedAt,
  settings,
}: {
  id: string;
  result: VideoAnalysisResult;
  title: string;
  fileName: string;
  /** For a sample: its public paths. Samples are never uploaded; the site already serves them. */
  demo: { videoUrl: string; posterUrl: string } | null;
  file: File | null;
  recordedAt: Date | null;
  settings: { confidenceThreshold: number; sampleFps: number };
}): Promise<VideoAnalysisDetail> {
  if (result.engine.isSynthetic) throw new Error("Synthetic detections are never saved.");
  const created = await call<{ analysis: VideoAnalysisDetail; uploads: Uploads }>("/video-analyses", {
    method: "POST",
    body: JSON.stringify({
      id,
      title,
      fileName,
      source: demo ? "demo" : "upload",
      videoUrl: demo?.videoUrl ?? null,
      posterUrl: demo?.posterUrl ?? null,
      videoContentType: demo ? null : file?.type || "video/mp4",
      recordedAt: recordedAt?.toISOString() ?? null,
      durationSeconds: result.durationSeconds,
      width: result.width,
      height: result.height,
      modelVersion: result.engine.modelVersion,
      confidenceThreshold: settings.confidenceThreshold,
      sampleFps: settings.sampleFps,
      framesAnalysed: result.framesAnalysed,
      rawDetections: result.rawDetections,
      rejectedTracks: result.rejectedTracks,
      averageInferenceMs: result.averageInferenceMs,
      potholes: result.potholes.map((p) => ({
        trackId: p.trackId,
        firstSeenSeconds: p.firstSeenSeconds,
        lastSeenSeconds: p.lastSeenSeconds,
        bestFrameSeconds: p.bestFrameSeconds,
        confidence: p.confidence,
        severity: p.severity.level,
        severityScore: p.severity.score,
        severityConfidence: p.severity.confidence,
        observationCount: p.observationCount,
        maxArea: p.maxArea,
        hasCrop: Boolean(p.cropImage),
        hasFull: Boolean(p.fullImage),
      })),
    }),
  });

  const done = { overlay: false, poster: false, video: false, crops: [] as string[], fulls: [] as string[] };
  const { uploads } = created;
  const attempt = async (target: StorageUploadTarget | null, blob: () => Promise<Blob>, mark: () => void) => {
    if (!target) return;
    try {
      await uploadToStorage(target, await blob());
      mark();
    } catch {
      // Recorded as not uploaded; the next save of the same analysis offers it again.
    }
  };

  await attempt(
    uploads.overlay,
    async () => new Blob([JSON.stringify(result.frames)], { type: "application/json" }),
    () => (done.overlay = true),
  );
  for (const pothole of result.potholes) {
    const targets = uploads.potholes[pothole.trackId];
    if (!targets) continue;
    if (pothole.cropImage) await attempt(targets.crop, () => dataUrlBlob(pothole.cropImage!), () => done.crops.push(pothole.trackId));
    if (pothole.fullImage) await attempt(targets.full, () => dataUrlBlob(pothole.fullImage!), () => done.fulls.push(pothole.trackId));
  }
  const firstFrame = result.potholes.find((p) => p.fullImage)?.fullImage;
  if (firstFrame) await attempt(uploads.poster, () => dataUrlBlob(firstFrame), () => (done.poster = true));
  if (file && file.size <= MAX_VIDEO_BYTES) await attempt(uploads.video, async () => file, () => (done.video = true));

  return call<VideoAnalysisDetail>(`/video-analyses/${id}/complete`, { method: "POST", body: JSON.stringify(done) });
}

/** A saved analysis in the shape the dashboard draws, so saved and fresh look the same. */
export function asResult(detail: VideoAnalysisDetail, frames: SampledFrame[]): VideoAnalysisResult {
  return {
    potholes: detail.potholes.map((p) => ({
      trackId: p.trackId,
      firstSeenSeconds: p.firstSeenSeconds,
      lastSeenSeconds: p.lastSeenSeconds,
      bestFrameSeconds: p.bestFrameSeconds,
      confidence: p.confidence,
      severity: { level: p.severity, score: p.severityScore, confidence: p.severityConfidence, rationale: "" },
      observationCount: p.observationCount,
      maxArea: p.maxArea,
      cropImage: p.cropUrl,
      fullImage: p.fullUrl,
    })),
    frames,
    framesAnalysed: detail.framesAnalysed,
    rejectedTracks: detail.rejectedTracks,
    rawDetections: detail.rawDetections,
    otherClasses: {},
    durationSeconds: detail.durationSeconds,
    width: detail.width,
    height: detail.height,
    averageInferenceMs: detail.averageInferenceMs,
    engine: {
      kind: "onnx",
      modelVersion: detail.modelVersion,
      backend: "saved",
      isSynthetic: false,
      selectionReason: "A saved analysis.",
    },
  };
}
