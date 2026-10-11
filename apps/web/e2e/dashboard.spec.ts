import { expect, test } from "@playwright/test";

// analysisId("demo:video-2", SAMPLE_SETUP): where the published analysis lives.
const VIDEO_2 = "b74149fd-b3bb-88ac-a229-1e7a89f40dec";
const MERGED = "pothole-road-anomaly-1.0.0+mfranzon-yolo26m-1.0.0+rezzzq-yolo12s-1.0.0";

const pothole = (trackId: string, severity: string, seconds: number) => ({
  id: crypto.randomUUID(),
  trackId,
  firstSeenSeconds: seconds,
  lastSeenSeconds: seconds + 1,
  bestFrameSeconds: seconds + 0.5,
  confidence: 0.6,
  severity,
  severityScore: 0.5,
  severityConfidence: 0.7,
  observationCount: 9,
  maxArea: 0.02,
  cropUrl: "/demo/video-2.jpg",
  fullUrl: null,
});

const DETAIL = {
  id: VIDEO_2,
  title: "Video 2",
  fileName: "VIDEO-2.MP4",
  source: "demo",
  createdAt: "2026-10-11T00:08:21Z",
  recordedAt: "2026-05-24T11:53:36Z",
  durationSeconds: 32.8,
  posterUrl: "/demo/video-2.jpg",
  potholeCount: 2,
  severityCounts: { small: 1, medium: 1, large: 0, unknown: 0 },
  location: null,
  modelVersion: MERGED,
  confidenceThreshold: 0.35,
  videoUrl: "/demo/video-2.mp4",
  overlayUrl: "/e2e/overlay.json",
  width: 1920,
  height: 1080,
  sampleFps: 12,
  framesAnalysed: 393,
  rawDetections: 73,
  rejectedTracks: 4,
  averageInferenceMs: 120,
  potholes: [pothole("track-008", "medium", 9), pothole("track-012", "small", 17)],
};

test("a sample opens from its published analysis, without downloading a detector", async ({ page }) => {
  // Starting a detector fetches its manifest first, before the model itself.
  const models: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/models/")) models.push(request.url());
  });
  await page.route(`**/api/v1/video-analyses/${VIDEO_2}`, (route) => route.fulfill({ json: DETAIL }));
  await page.route("**/e2e/overlay.json", (route) => route.fulfill({ json: [] }));

  await page.goto("/?video=video-2");

  await expect(page.getByText("Saved for everyone")).toBeVisible();
  await expect(page.getByText(/3 open-source detectors, merged/i)).toBeVisible();
  await expect(page.getByRole("link", { name: "mfranzon YOLO26m" })).toHaveAttribute("href", /huggingface\.co/);
  await page.waitForTimeout(1000);
  expect(models).toEqual([]);
});

test("a sample with no published analysis offers to analyse it in the browser", async ({ page }) => {
  await page.route(`**/api/v1/video-analyses/${VIDEO_2}`, (route) =>
    route.fulfill({ status: 404, json: { detail: "Video analysis not found" } }),
  );

  await page.goto("/?video=video-2");

  await expect(page.getByRole("button", { name: /analyse in your browser/i })).toBeVisible();
  await expect(page.getByText("Saved for everyone")).toHaveCount(0);
});
