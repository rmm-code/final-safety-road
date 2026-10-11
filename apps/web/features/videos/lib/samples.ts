import type { AnalysisSettings } from "./analysis-id";

/**
 * The four sample videos, served from public/demo. Mirrored by ai/samples/catalog.py, which
 * analyses them and publishes the results.
 */
export type Sample = {
  id: string;
  /**
   * analysisId(`demo:${id}`, SAMPLE_SETUP), where its published analysis is saved. Written
   * out because crypto.subtle is missing on a plain-HTTP origin; samples.test.ts checks it.
   */
  analysisId: string;
  title: string;
  description: string;
  src: string;
  poster: string;
  /** mm:ss, as the sidebar shows it. */
  durationLabel: string;
  /** When the clip starts, from the dashcam's on-screen clock; null when unknown. */
  recordedAt: string | null;
  /** Where it was filmed, when the team knows. The files carry no GPS. */
  placement: { latitude: number; longitude: number; accuracyM: number; label: string } | null;
};

/**
 * The setup the samples are published with: our YOLO26m, trained on public data only (it
 * never saw these videos), at 0.25. Until 2026-10-11 it was the 3-model merge at 0.35.
 * Frozen here, not read from config, so a threshold change elsewhere never loses the
 * published analyses. Mirrors ai/samples/catalog.py; change both together.
 */
export const SAMPLE_SETUP: AnalysisSettings = {
  modelVersion: "pothole-yolo26m-public-0.1.0",
  confidenceThreshold: 0.25,
  sampleFps: 12,
};

/** The sample the dashboard opens on: it has potholes and a known location. */
export const DEFAULT_SAMPLE_ID = "video-2";

export const SAMPLES: Sample[] = [
  {
    id: "video-1",
    analysisId: "4d338afb-b05b-8a29-8d9f-d6f95c0f56e4",
    title: "Video 1",
    description: "Residential lane, Tashkent",
    src: "/demo/video-1.mp4",
    poster: "/demo/video-1.jpg",
    durationLabel: "00:06",
    // Tashkent is UTC+5; the dashcam stamps local time.
    recordedAt: "2026-05-25T05:12:58Z",
    placement: null,
  },
  {
    id: "video-2",
    analysisId: "4d22bf79-4764-8ade-8328-d4d1bcddb0ac",
    title: "Video 2",
    description: "By Osiyo Grand, off Labzak street",
    src: "/demo/video-2.mp4",
    poster: "/demo/video-2.jpg",
    durationLabel: "00:33",
    recordedAt: "2026-05-24T11:53:36Z",
    // The side road north of Osiyo Grand, marked by the team; 100 m covers it, the parking
    // lot and the courtyard behind the building.
    placement: {
      latitude: 41.32528,
      longitude: 69.26345,
      accuracyM: 100,
      label: "Osiyo Grand, off Labzak street",
    },
  },
  {
    id: "video-3",
    analysisId: "6c354188-9578-816c-b18d-81165747d717",
    title: "Video 3",
    description: "Residential streets, Tashkent",
    src: "/demo/video-3.mp4",
    poster: "/demo/video-3.jpg",
    durationLabel: "00:24",
    recordedAt: "2026-05-24T08:36:41Z",
    placement: null,
  },
  {
    id: "video-4",
    analysisId: "4a26dba3-c07f-8513-92f2-cbcb6cb56982",
    title: "Video 4",
    description: "Badly broken road, Russia",
    src: "/demo/video-4.mp4",
    poster: "/demo/video-4.jpg",
    durationLabel: "00:09",
    recordedAt: null,
    placement: null,
  },
];

export function findSample(id: string | null): Sample {
  return SAMPLES.find((sample) => sample.id === id) ?? SAMPLES.find((sample) => sample.id === DEFAULT_SAMPLE_ID)!;
}

/** The sample a saved analysis is of, by its poster path; undefined for an upload. */
export function sampleOf(posterUrl: string | null): Sample | undefined {
  return posterUrl ? SAMPLES.find((sample) => sample.poster === posterUrl) : undefined;
}
