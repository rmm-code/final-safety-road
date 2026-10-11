import { expect, test } from "@playwright/test";

/** The live demo: usable without a backend and without a camera. */
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

test("offers the four sample videos, so it can be tried without footage", async ({ page }) => {
  await page.goto("/analyze");
  for (const name of ["Video 1", "Video 2", "Video 3", "Video 4"]) {
    await expect(page.getByRole("button", { name: new RegExp(name) })).toBeVisible();
  }
});
