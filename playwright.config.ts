import { defineConfig, devices } from "@playwright/test";

/**
 * The sign-in suite: real pages, real clicks, two widths.
 *
 * `PW_CHANNEL` picks the browser. Locally it is `chrome`, which is the browser on this machine and
 * costs no download; CI leaves it unset and runs the bundled chromium. Everything else in this file
 * is shared, so the browser is the only difference between the two.
 */
const channel = process.env.PW_CHANNEL;

export default defineConfig({
  testDir: "./e2e",
  // One worker: every test drives the same stack, and a link sent in one test is read from the same
  // mailbox another test is waiting on. Parallelism here buys seconds and costs a flaky suite.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI === undefined ? 0 : 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI === undefined ? [["list"]] : [["list"], ["github"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    ...(channel === undefined || channel === "" ? {} : { channel }),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone",
      use: { ...devices["iPhone 13"], viewport: { width: 375, height: 812 } },
    },
    {
      name: "desktop",
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
});
