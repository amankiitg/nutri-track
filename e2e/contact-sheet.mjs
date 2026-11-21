/**
 * Every state of /auth at 375 px, in one labelled image.
 *
 * Run against the local stack: `node e2e/contact-sheet.mjs`. It plants the accounts a state needs
 * (link only, link plus Google, a password, Google only, an invited address), opens each state in a
 * phone-sized browser, screenshots it, then lays the PNGs out with captions on one page and
 * screenshots that. The result is `~/openclaw/workspace/outbox`'s sibling, or the path printed at the
 * end.
 *
 * This writes to the local database only. It reads the stack through `psql` on the loopback port and
 * never touches production.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const APP = "http://127.0.0.1:5173";
const DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const OUT = "/Users/amankesarwani/.openclaw/workspace/outbox";
const SHOTS = "/tmp/auth-states";

function sql(query) {
  return execFileSync("psql", [DB, "-v", "ON_ERROR_STOP=1", "-tA"], {
    input: query,
    encoding: "utf8",
  }).trim();
}

const LINK_ONLY = "sheet.link@example.com";
const LINK_GOOGLE = "sheet.linkgoogle@example.com";
const HAS_PASSWORD = "sheet.password@example.com";
const GOOGLE_ONLY = "sheet.google@example.com";
const INVITED = "sheet.invited@example.com";
const STRANGER = "sheet.stranger@example.com";

function plant(email, providers, { password = false } = {}) {
  sql(`delete from auth.users where email = '${email}'`);
  sql(
    `insert into auth.users (id, email, email_confirmed_at) values (gen_random_uuid(), '${email}', now())`,
  );
  const id = sql(`select id from auth.users where email = '${email}'`);
  for (const provider of providers) {
    sql(
      `insert into auth.identities (id, user_id, provider, provider_id, identity_data) values (gen_random_uuid(), '${id}', '${provider}', '${id}', jsonb_build_object('email', '${email}'))`,
    );
  }
  if (password) {
    sql(
      `insert into public.profiles (user_id, display_name, dob, sex, height_cm, weight_kg, activity_level, goal, has_password) values ('${id}', 'Ada', '1994-01-01', 'female', 165, 70, 'moderately_active', 'lose', true) on conflict (user_id) do update set has_password = true`,
    );
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  sql("update public.app_settings set open_signups = true");
  sql(`delete from public.allowed_emails where email = '${INVITED}'`);
  sql(`delete from public.allowed_emails where email = '${STRANGER}'`);
  sql(
    `insert into public.allowed_emails (email) values ('${INVITED}') on conflict (email) do nothing`,
  );
  plant(LINK_ONLY, ["email"]);
  plant(LINK_GOOGLE, ["email", "google"]);
  plant(HAS_PASSWORD, ["email"], { password: true });
  plant(GOOGLE_ONLY, ["google"]);

  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const shots = [];

  async function shot(name, label) {
    const path = `${SHOTS}/${name}.png`;
    await page.screenshot({ path });
    shots.push({ path, label });
    console.log("shot:", name);
  }

  async function open() {
    const ready = page.waitForResponse((response) => response.url().endsWith("/rpc/open_signups"));
    await page.goto(`${APP}/auth`);
    await ready;
    sql("delete from public.auth_entry_state_throttle");
  }

  async function ask(email) {
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }

  await open();
  await shot("01-email", "The address step, sign-ups open");

  await ask(STRANGER);
  await page.waitForTimeout(600);
  await shot("02-open-signup", "No account, sign-ups open: create it by link");

  await open();
  await ask(INVITED);
  await page.waitForTimeout(600);
  await shot("03-invited-new", "On the list, no account yet");

  sql("update public.app_settings set open_signups = false");
  await open();
  await ask(STRANGER);
  await page.waitForTimeout(600);
  await shot("04-not-invited", "Not on the list, sign-ups closed");
  sql("update public.app_settings set open_signups = true");

  await open();
  await ask(LINK_ONLY);
  await page.waitForTimeout(600);
  await shot("05-link-only", "A magic-link account: one door, no password control");

  await open();
  await ask(LINK_GOOGLE);
  await page.waitForTimeout(600);
  await shot("06-link-and-google", "A link account that also has Google");

  await open();
  await ask(HAS_PASSWORD);
  await page.waitForTimeout(600);
  await shot("07-has-password", "A password account: the password view arrives first");

  await page.getByRole("button", { name: /use an email link instead/i }).click();
  await page.waitForTimeout(400);
  await shot("08-has-password-link", "The same account, switched to the link view");

  await open();
  await ask(GOOGLE_ONLY);
  await page.waitForTimeout(600);
  await shot("09-google-only", "A Google-only account");

  await open();
  await ask(LINK_ONLY);
  const before = page.waitForResponse((response) => response.url().includes("/auth/v1/otp"));
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await before;
  await page.waitForTimeout(400);
  await shot("10-inbox", "The link went out: the inbox panel with its 60 second resend");

  await open();
  await ask(HAS_PASSWORD);
  await page.getByRole("button", { name: /forgot password/i }).click();
  await page.waitForTimeout(400);
  await shot("11-reset", "Forgot password: the reset step");

  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: "window.turnstile = { render: function () { return 'w1'; }, execute: function () {}, reset: function () {}, remove: function () {} };",
    });
  });
  await open();
  await ask(HAS_PASSWORD);
  await page.getByRole("button", { name: /use an email link instead/i }).click();
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.waitForTimeout(20_000);
  await shot(
    "12-security-check",
    "The security check did not finish: it says so, and sends nothing",
  );

  const figures = shots
    .map(
      (item) =>
        `<figure><img src="file://${item.path}" width="375" /><figcaption>${item.label}</figcaption></figure>`,
    )
    .join("\n");

  const sheet = `<!doctype html><html><head><meta charset="utf-8" /><style>
    body { margin: 0; background: #f0ece4; font-family: ui-sans-serif, system-ui, sans-serif; width: 820px; }
    h1 { font-size: 20px; margin: 24px 24px 8px; color: #2f3a2b; }
    p { margin: 0 24px 16px; color: #55603f; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 0 24px 32px; }
    figure { margin: 0; background: #fff; border-radius: 12px; padding: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    img { display: block; width: 375px; border-radius: 8px; }
    figcaption { font-size: 12px; color: #2f3a2b; margin-top: 6px; line-height: 1.35; }
  </style></head><body>
    <h1>NutriTrack: every state of /auth at 375 px</h1>
    <p>Generated from the local stack. Each panel is one state, and the caption says which.</p>
    <div class="grid">${figures}</div>
  </body></html>`;

  const sheetPath = "/tmp/auth-states/sheet.html";
  writeFileSync(sheetPath, sheet);

  const sheetPage = await browser.newPage({ viewport: { width: 820, height: 900 } });
  await sheetPage.goto(`file://${sheetPath}`);
  await sheetPage.waitForTimeout(600);
  const target = `${OUT}/auth-states-375.png`;
  await sheetPage.screenshot({ path: target, fullPage: true });
  console.log("sheet:", target);
  await browser.close();
}

await main();
