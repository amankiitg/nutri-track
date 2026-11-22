/**
 * The sign-in screen, walked the way a person walks it.
 *
 * Every case here drives the real app against the local Supabase stack, clicks the real link out of
 * the local inbox, and runs at both widths (the two projects in playwright.config.ts). The only
 * thing stubbed is Google itself: the browser is not going to sign in to a real Google account, so
 * the redirect is captured at the moment it is attempted and the URL is what gets asserted.
 *
 * The cases are lettered to match the checklist they came from, and serial because they build on one
 * account: (a) creates it, (b) signs it back in, (c) gives it a password, (d) resets that password.
 */
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    /** The inputs the photo buttons opened, in order, recorded by the check in case (a). */
    __photoOpened?: string[];
  }
}
import {
  askState,
  expect,
  expectQuietLinksSeparated,
  freshEmail,
  invite,
  linkOf,
  mailCount,
  mailTo,
  setOpenSignups,
  signOut,
  sql,
  test,
  uninvite,
  watch,
} from "./support";

const FIRST_PASSWORD = "battery horse correct";
const SECOND_PASSWORD = "correct horse battery";
const GOOGLE_ONLY = "google.only@example.com";
const LINK_ONLY = "link.only@example.com";

/**
 * Opens the sign-in page and waits for the app to be interactive.
 *
 * The wait is the app's own first request: the effects have run, so a click lands on a hydrated
 * handler rather than on server-rendered markup. Without it a test can type into a field React has
 * not attached to yet and watch nothing happen.
 */
async function openAuth(page: Page): Promise<void> {
  const ready = page.waitForResponse((response) => response.url().endsWith("/rpc/open_signups"));
  try {
    await page.goto("/auth");
  } catch (error) {
    // A client side redirect that lands while the navigation is still in flight aborts the goto.
    // One retry, and only one: a page that cannot be loaded twice is broken rather than racing.
    if (!String(error).includes("ERR_ABORTED")) throw error;
    await page.goto("/auth");
  }
  await ready;
}

/** The wizard's Continue, in one place because every step has exactly one. */
async function nextStep(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

/** Walks the six onboarding steps to Today, filling the same answers a person would. */
async function finishOnboarding(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByLabel("Display name").fill("Ada");
  await page.getByLabel("Date of birth").fill("1994-01-01");
  await page.getByLabel("Female").click();
  await nextStep(page);

  await page.getByLabel(/Metric/).click();
  await page.getByLabel("Height").fill("165");
  await page.getByLabel("Weight").fill("70");
  await nextStep(page);

  // Activity: the first of the five, which is the least assumption about the copy on the card.
  await page.locator("label").first().click();
  await nextStep(page);

  await page.getByLabel(/Lose weight/).click();
  await page.getByLabel("Target weight").fill("60");
  await page.getByLabel("0.5 kg/week").click();
  await nextStep(page);

  // Preferences are optional.
  await nextStep(page);
  await page.getByRole("button", { name: "Confirm and save" }).click();
  await expect(page).toHaveURL(/\/today/, { timeout: 20_000 });
}

/** Plants a user in the local database in a shape only SQL can make. */
function plantUser(email: string, providers: readonly string[]): void {
  // Insert, then ask for the id: psql prints the INSERT command tag after the returned row, so a
  // RETURNING on stdin is not a value a script can read off the end of the output.
  sql(
    "insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), :'email', now())",
    { email },
  );
  const id = sql("select id from auth.users where email = :'email'", { email });
  for (const provider of providers) {
    sql(
      "insert into auth.identities (id, user_id, provider, provider_id, identity_data) values (gen_random_uuid(), :'id', :'provider', :'id', jsonb_build_object('email', :'email'))",
      { id, provider, email },
    );
  }
}

function forgetUser(email: string): void {
  sql("delete from auth.users where email = :'email'", { email });
}

test.describe.serial("the sign-in screen, end to end", () => {
  const account = freshEmail("new", "suite");

  test.beforeAll(() => {
    setOpenSignups(true);
  });

  test("a. a new address gets the sign-up screen, and the emailed link lands it on Today", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    uninvite(account);
    await openAuth(page);
    await askState(page, account);

    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    const before = await mailCount(account);
    await page.getByRole("button", { name: "Email me a link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

    // The local stack has confirmations off, so GoTrue writes the magic-link template for a new
    // address as well: the link proves the inbox either way.
    const mail = await mailTo(account, before);
    await page.goto(linkOf(mail, "magiclink"));

    // The link proves the inbox, which is what lets a password be set here and nowhere earlier.
    await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible();
    await page.getByRole("button", { name: "Skip, take me in" }).click();

    await finishOnboarding(page);

    // The sheet's two photo inputs, at phone size. Two, not one: Take a photo carries
    // capture="environment" so the phone opens the camera, and Choose does not, so it opens the
    // library. Each button opens its own input.
    await page.getByRole("button", { name: "Add a meal" }).click();
    await expect(page.locator('input[data-photo-input="camera"]')).toHaveAttribute(
      "capture",
      "environment",
    );
    await expect(page.locator('input[data-photo-input="gallery"]')).not.toHaveAttribute("capture");

    await page.evaluate(() => {
      const opened: string[] = [];
      const native = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function patched(this: HTMLInputElement, ...args) {
        opened.push(this.dataset["photoInput"] ?? "unknown");
        window.__photoOpened = opened;
        return native.apply(this, args as never);
      };
    });
    await page.getByRole("button", { name: /take a photo/i }).click();
    await page.getByRole("button", { name: /^choose$/i }).click();
    expect(await page.evaluate(() => window.__photoOpened ?? [])).toEqual(["camera", "gallery"]);
  });

  test("b. the same account sees only the link, and the link signs it in", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    // A fresh browser, the same account: what the next visit looks like.
    await openAuth(page);
    await askState(page, account);

    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
    const link = page.getByRole("button", { name: "Email me a sign-in link" });
    await expect(link).toBeVisible();
    // No password control of any kind: this account has never had a password to type.
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /use a password instead/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /forgot password/i })).toHaveCount(0);

    const before = await mailCount(account);
    await link.click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    const mail = await mailTo(account, before);
    await page.goto(linkOf(mail, "magiclink"));
    await expect(page).toHaveURL(/\/today/, { timeout: 20_000 });
  });

  test("c. a password set in Settings becomes the first door, and a wrong one shows the detail", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    // In, by the link, because Settings needs a session and this account has no password yet.
    await openAuth(page);
    await askState(page, account);
    const entry = await mailCount(account);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.goto(linkOf(await mailTo(account, entry), "magiclink"));
    await expect(page).toHaveURL(/\/today/, { timeout: 20_000 });

    await page.goto("/settings");
    // The Settings card says "Set a password" for an account with none, and its fields are labelled
    // for what they are: a new password and its confirmation.
    await page
      .getByRole("button", { name: /set a password/i })
      .first()
      .click();
    await page.getByLabel("New password").fill(FIRST_PASSWORD);
    await page.getByLabel("Confirm password").fill(FIRST_PASSWORD);
    await page.getByRole("button", { name: "Set a password", exact: true }).click();
    await expect(page.getByRole("button", { name: /change password/i })).toBeVisible();

    // The flag is recorded, which is what makes the sign-in screen offer the box at all.
    expect(
      sql(
        "select p.has_password from public.profiles p join auth.users u on u.id = p.user_id where u.email = :'email'",
        { email: account },
      ),
    ).toBe("t");

    await signOut(page);
    // A plain /auth, not the ?redirect=/settings the sign-out guard left behind: that redirect is
    // honoured after sign-in, and this case is about the sign-in screen rather than where somebody
    // was going.
    await openAuth(page);
    await askState(page, account);

    // The password view, with the link one press away.
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    // Three quiet links under the form, each on its own line.
    await expectQuietLinksSeparated(page);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /use an email link instead/i })).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill("not the password");
    await page.getByRole("button", { name: "Sign in" }).click();
    // The sentence, and the raw error under it: the detail line is what a person can quote.
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByText(/invalid_credentials|Invalid login credentials/i).first(),
    ).toBeVisible();

    await page.getByLabel("Password", { exact: true }).fill(FIRST_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/today/, { timeout: 20_000 });
  });

  test("d. Forgot password sends a reset link, and the new password signs in", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    await openAuth(page);
    await askState(page, account);
    // The password view arrives, and its quiet link opens the reset step.
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /forgot password/i }).click();

    const before = await mailCount(account);
    await page.getByRole("button", { name: /send reset link/i }).click();
    await expect(page.getByRole("status")).toBeVisible();
    const mail = await mailTo(account, before);
    // domcontentloaded, because this navigation is a 303 into a page that then keeps loading fonts
    // and the captcha script: waiting for the load event waits for all of them, and on this stack
    // that is where the ninety seconds went.
    await page.goto(linkOf(mail, "recovery"), { waitUntil: "domcontentloaded" });

    // The reset screen names its fields for what they are: a new password, and its confirmation.
    await page.getByLabel("New password").fill(SECOND_PASSWORD);
    await page.getByLabel("Confirm password").fill(SECOND_PASSWORD);
    await page.getByRole("button", { name: "Set a new password" }).click();
    await expect(page).toHaveURL(/\/today/, { timeout: 20_000 });

    // The reset leaves the person signed in, and /auth sends a signed-in visitor to Today, so the
    // second half of this case starts by signing out: the point is the new password, not the state
    // the reset left behind.
    await signOut(page);
    await openAuth(page);
    await askState(page, account);
    await page.getByLabel("Password", { exact: true }).fill(SECOND_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/today/, { timeout: 20_000 });
  });

  test("e. Continue with Google asks GoTrue to start the flow and to come back to the callback", async ({
    page,
    harness,
  }) => {
    watch(page, harness);

    // The provider redirect is captured here instead of followed: this suite never talks to Google,
    // and the URL is the thing under test.
    let attempted: string | null = null;
    await page.route("**/auth/v1/authorize**", async (route) => {
      attempted = route.request().url();
      await route.fulfill({ status: 204, body: "" });
    });

    await openAuth(page);
    await page.getByRole("button", { name: "Continue with Google" }).click();

    await expect.poll(() => attempted).not.toBeNull();
    const url = new URL(attempted ?? "");
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe("http://127.0.0.1:5173/auth/callback");

    // A Google-only account: Google is the primary door and the link sits beside it.
    forgetUser(GOOGLE_ONLY);
    plantUser(GOOGLE_ONLY, ["google"]);
    await page.unroute("**/auth/v1/authorize**");
    await openAuth(page);
    await askState(page, GOOGLE_ONLY);
    await expect(
      page.getByRole("heading", { name: "This account signs in with Google." }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    // The two quiet links of the Google-only panel, on their own lines, with the new words.
    await expect(
      page.getByRole("button", { name: "Prefer email? Send me a sign-in link" }),
    ).toBeVisible();
    await expectQuietLinksSeparated(page);
  });

  test("f. the two views toggle without ever stacking", async ({ page, harness }) => {
    watch(page, harness);
    await openAuth(page);
    await askState(page, account);
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();

    for (let round = 0; round < 3; round += 1) {
      await page.getByRole("button", { name: /use an email link instead/i }).click();
      await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(1);
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
      await expectQuietLinksSeparated(page);

      await page.getByRole("button", { name: /use a password instead/i }).click();
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toHaveCount(0);
      await expectQuietLinksSeparated(page);
    }

    // The focus follows the view: the field in the password view, the button in the link view.
    await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
    await page.getByRole("button", { name: /use an email link instead/i }).click();
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeFocused();
  });

  test("g. use a different email returns to the address step, empty, from every state", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    forgetUser(LINK_ONLY);
    // An email identity and no session: the shape a magic-link sign-up leaves behind.
    plantUser(LINK_ONLY, ["email"]);

    const states = [
      { email: account, heading: "Welcome back" },
      { email: LINK_ONLY, heading: "Welcome back" },
      { email: GOOGLE_ONLY, heading: "This account signs in with Google." },
    ];

    // One visit, three states: "use a different email" is what puts the screen back on the address
    // step, so navigating again in between would be testing the navigation rather than the button.
    await openAuth(page);
    for (const state of states) {
      await askState(page, state.email);
      await expect(page.getByRole("heading", { name: state.heading })).toBeVisible();
      await page.getByRole("button", { name: /use a different email/i }).click();
      await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
      await expect(page.getByLabel("Email", { exact: true })).toHaveValue("");
    }
  });

  test("h. the resend control is held for a minute and sends nothing while it is held", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    await openAuth(page);
    await askState(page, account);
    await page.getByRole("button", { name: /use an email link instead/i }).click();

    const before = await mailCount(account);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

    const resend = page.getByRole("button", { name: /resend in \d+s/i });
    await expect(resend).toBeDisabled();
    await resend.click({ force: true });
    // Give a send that should not happen time to happen, then count.
    await page.waitForTimeout(1500);
    expect(await mailCount(account)).toBe(before + 1);
  });

  test("l. a security check that never finishes says so, and sends nothing", async ({
    page,
    harness,
  }) => {
    watch(page, harness);

    // A widget that exists and answers nothing. This is the shape of the failure the local stack
    // showed: the press went out without a token, GoTrue refused it for that reason, and the screen
    // blamed the password. The check now waits twice and then refuses to send at all.
    await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: "window.turnstile = { render: function () { return 'w1'; }, execute: function () {}, reset: function () {}, remove: function () {} };",
      });
    });

    const attempts: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/auth/v1/")) attempts.push(request.url());
    });

    await openAuth(page);
    await askState(page, account);
    await page.getByRole("button", { name: /use an email link instead/i }).click();
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();

    // The exact sentence, and the button back so a second tap is possible.
    await expect(
      page.getByText(/security check is still loading\. tap again in a second\./i),
    ).toBeVisible({
      timeout: 25_000,
    });
    await expectQuietLinksSeparated(page);
    await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeEnabled();

    // Nothing was sent, and nothing claims the email is on its way.
    expect(attempts.filter((url) => url.includes("/otp"))).toEqual([]);
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toHaveCount(0);
    await expect(page.getByText(/captcha protection/i)).toHaveCount(0);
  });

  test("i. with the switch off, an unknown address hits the wall and an invited one still gets in", async ({
    page,
    harness,
  }) => {
    watch(page, harness);
    setOpenSignups(false);

    const stranger = freshEmail("stranger", "suite");
    uninvite(stranger);
    await openAuth(page);
    await askState(page, stranger);
    await expect(
      page.getByRole("heading", { name: "This email isn't invited yet." }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Request an invite" })).toBeVisible();

    const invited = freshEmail("invited", "suite");
    invite(invited);
    await openAuth(page);
    await askState(page, invited);
    await expect(page.getByRole("heading", { name: "You're invited!" })).toBeVisible();
    // The last sentence, in the words this branch settled on.
    await expect(page.getByText("You can set a password later in Settings.")).toBeVisible();

    const before = await mailCount(invited);
    await page.getByRole("button", { name: "Email me a link" }).click();
    const mail = await mailTo(invited, before);
    await page.goto(linkOf(mail, "magiclink"));
    await expect(page.getByRole("heading", { name: "You're in" })).toBeVisible();
    await page.getByRole("button", { name: "Skip, take me in" }).click();
    await finishOnboarding(page);

    setOpenSignups(true);
    uninvite(invited);
  });
});
