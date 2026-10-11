import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests.
 *
 * These cover what unit tests cannot: that a route actually renders in a browser, that
 * navigation works, and that the app degrades honestly when the API is unreachable.
 * They run against the dev server and do not require the backend to be up - a page that
 * only works with a live database is a page that cannot be smoke-tested.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The dev server's own port, reused when one is already running. A second port does not
  // avoid a collision: Next.js 16 refuses to start another `next dev` in this folder, so
  // a separate test server failed every test with ERR_CONNECTION_REFUSED.
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        port: 3000,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
