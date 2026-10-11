import { expect, test, type Page } from "@playwright/test";

/**
 * A drive that actually runs: Chromium's fake camera, a fixed GPS position, and an API
 * that answers 503 so nothing reaches a real database.
 *
 * The other drive specs all stop before "Start drive". That is how a drive page that never
 * fed a single frame to the detector passed the whole suite.
 */
test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["camera", "geolocation"],
  geolocation: { latitude: 41.3112, longitude: 69.2797, accuracy: 8 },
});

async function metric(page: Page, label: RegExp): Promise<number> {
  const value = page.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd");
  return Number((await value.first().textContent())?.trim() ?? "0");
}

test("a started drive feeds camera frames to the detector", async ({ page }) => {
  // Loading the model and the first WASM inferences take a while in headless Chromium.
  test.setTimeout(120_000);
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "stubbed by the e2e suite" }),
    }),
  );

  await page.goto("/drive");
  const start = page.getByRole("button", { name: "Start drive" });
  await expect(start).toBeEnabled({ timeout: 90_000 });
  await start.click();

  await expect
    .poll(() => metric(page, /^frames analysed$/i), { timeout: 30_000 })
    .toBeGreaterThan(0);
});
