/**
 * Case j: CAPTCHA off.
 *
 * This needs a stack whose GoTrue has `[auth.captcha] enabled = false` and an app built without a
 * Turnstile site key, which is a different run from the rest of the suite: `e2e/run-captcha-off.sh`
 * rewrites the local config, restarts the stack, writes a .env.e2e with no site key, and then runs
 * this file. It is skipped rather than failing when it is run by accident inside the normal suite.
 */
import type { Page } from "@playwright/test";
import {
  askState,
  expect,
  freshEmail,
  linkOf,
  mailCount,
  mailTo,
  setOpenSignups,
  test,
  uninvite,
  watch,
} from "./support";

const ENABLED = process.env["E2E_CAPTCHA_OFF"] === "1";

async function openAuth(page: Page): Promise<void> {
  const ready = page.waitForResponse((response) => response.url().endsWith("/rpc/open_signups"));
  await page.goto("/auth");
  await ready;
}

test.describe("with CAPTCHA off", () => {
  test.skip(!ENABLED, "run through e2e/run-captcha-off.sh, which turns the stack's captcha off");

  test("signs a new address up by link, with no widget and no security-check message", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    setOpenSignups(true);

    const email = freshEmail("nocaptcha", test.info().project.name);
    uninvite(email);

    await openAuth(page);
    // No widget mounts: there is no site key, so nothing renders into the container.
    await expect(page.locator("[data-turnstile] *")).toHaveCount(0);

    await askState(page, email);
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

    const before = await mailCount(email);
    await page.getByRole("button", { name: "Email me a link" }).click();

    // The request went without a token, the stack accepted it, and nobody was told to tap again.
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await expect(page.getByText(/security check is still loading/i)).toHaveCount(0);

    const mail = await mailTo(email, before);
    await page.goto(linkOf(mail, "magiclink"), { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible();
  });
});
