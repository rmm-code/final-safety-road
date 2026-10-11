import { expect, test } from "@playwright/test";

/** The live demo: a visitor's own video, usable without a backend and without a camera. */
test("states plainly that a video file has no GPS", async ({ page }) => {
  await page.goto("/analyze");
  await expect(page.getByText(/has no GPS/i).first()).toBeVisible();
});

test("will not analyze before a video is chosen", async ({ page }) => {
  await page.goto("/analyze");
  await expect(page.getByRole("button", { name: /analyze video/i })).toBeDisabled();
});

test("rejects a file that is not a video", async ({ page }) => {
  await page.goto("/analyze");
  await page.setInputFiles('input[type="file"]', {
    name: "notes.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4"),
  });
  await expect(page.getByText(/not a video file/i)).toBeVisible();
});

test("is for the visitor's own video: one choose button with the size limit, no samples", async ({ page }) => {
  await page.goto("/analyze");
  await expect(page.getByRole("button", { name: "Choose video" })).toHaveCount(1);
  await expect(page.getByText(/up to 95 MB/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Video 2/ })).toHaveCount(0);
  await expect(page.getByText(/four sample videos/i)).toHaveCount(0);
});

test("shows no detections or selected-pothole cards before an analysis", async ({ page }) => {
  await page.goto("/analyze");
  await expect(page.getByRole("heading", { name: /find potholes/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Detections" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Selected pothole" })).toHaveCount(0);
});
