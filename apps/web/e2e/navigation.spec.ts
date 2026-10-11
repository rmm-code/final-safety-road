import { expect, test } from "@playwright/test";

/** Every route renders its own chrome, with or without the API behind it. */
const ROUTES = [
  { path: "/", heading: /pothole overview/i },
  { path: "/analyze", heading: /find potholes in a road video/i },
  { path: "/videos", heading: /sample videos/i },
  { path: "/potholes", heading: /potholes/i },
  { path: "/map", heading: /^map$/i },
  { path: "/drive", heading: /live drive/i },
  { path: "/dashboard", heading: /statistics/i },
  { path: "/about", heading: /road damage intelligence/i },
  { path: "/models", heading: /model comparison/i },
];

for (const route of ROUTES) {
  test(`${route.path} renders`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(route.path);
    await expect(page.getByRole("heading", { name: route.heading }).first()).toBeVisible();
    expect(errors, `uncaught errors on ${route.path}`).toEqual([]);
  });
}

test("the map still works when reached from an isolated page", async ({ page }) => {
  // A client-side navigation keeps /analyze's isolation, and MapLibre's worker must still
  // load: without it the map is a blank canvas with no error.
  await page.goto("/analyze");
  await expect(page.getByRole("heading", { name: /find potholes/i }).first()).toBeVisible();
  const mapWorker = page.waitForEvent("worker", {
    predicate: (worker) => worker.url().includes("/maplibre/"),
    timeout: 20_000,
  });
  await page.getByRole("link", { name: /^map$/i }).first().click();
  await expect(page).toHaveURL(/\/map/);
  await mapWorker;
});

test("the sidebar links sections and samples", async ({ page }) => {
  await page.goto("/about");
  await page.getByRole("link", { name: /live demo/i }).first().click();
  await expect(page).toHaveURL(/\/analyze$/);
  await page.getByRole("link", { name: /^map$/i }).first().click();
  await expect(page).toHaveURL(/\/map/);
  await page.getByRole("link", { name: /video 3/i }).first().click();
  await expect(page).toHaveURL(/\/\?video=video-3$/);
});
