import { expect, test } from "@playwright/test";

/**
 * The drive page cannot be fully exercised headlessly - it needs a rear camera and a GPS
 * fix. What can be checked is that it refuses to start rather than failing obscurely, and
 * that it explains why.
 */
test.use({ permissions: [] });

test("offers to start a drive", async ({ page }) => {
  await page.goto("/drive");
  await expect(page.getByRole("button", { name: /start drive/i })).toBeVisible();
});

test("tells the driver to mount the phone before moving", async ({ page }) => {
  await page.goto("/drive");
  await expect(page.getByText(/before moving/i)).toBeVisible();
});

test("explains a refused camera instead of failing silently", async ({ page, context }) => {
  await context.grantPermissions([]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => {
          const error = new Error("Permission denied");
          error.name = "NotAllowedError";
          return Promise.reject(error);
        },
      },
    });
  });

  await page.goto("/drive");
  await page.getByRole("button", { name: /start drive/i }).click();
  await expect(page.getByText(/camera access was refused/i)).toBeVisible();
});

test("runs isolated, so the WASM detector can use threads", async ({ page }) => {
  // Arrive by a client-side link, the case the server's headers alone cannot cover.
  await page.goto("/");
  await page.getByRole("link", { name: /live drive/i }).first().click();
  // The page reloads itself once to pick up isolation; poll across that reload.
  await expect
    .poll(() => page.evaluate(() => window.crossOriginIsolated).catch(() => false))
    .toBe(true);
  await expect(page.getByRole("button", { name: /start drive/i })).toBeVisible();
});

test("says which runtime the detector got, before the drive starts", async ({ page }) => {
  // WebGPU or WASM is the browser's choice and decides the frame rate, so it must be
  // checkable on the phone itself.
  await page.goto("/drive");
  await expect(page.getByText(/^(WebGPU|WASM \(CPU\)|Synthetic|mock)/).first()).toBeVisible({
    timeout: 60_000,
  });
});
