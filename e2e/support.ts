/**
 * The pieces the sign-in suite needs from the local stack, and the guard that keeps it local.
 *
 * Two rules in this file, both about not letting a test touch anything real:
 *
 *   1. Every request leaves through context.route, and a host that is not in ALLOWED_HOSTS is
 *      aborted and reported. If the app were ever pointed at production the first request fails here
 *      by name, rather than quietly sending mail to a real inbox.
 *   2. Mail is read from the local inbox (Mailpit) and the links in it are opened for real, so the
 *      flows under test are the ones a person walks.
 */
import { execFileSync } from "node:child_process";
import { test as base, expect, type ConsoleMessage, type Page } from "@playwright/test";

// Bracket access because the project does not allow dot access on an index signature, which is
// what process.env is.
export const MAILPIT_URL = process.env["E2E_MAILPIT_URL"] ?? "http://127.0.0.1:54324";
export const DB_URL =
  process.env["E2E_DB_URL"] ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

/**
 * Everything a test may talk to. Production is not in this list, on purpose.
 *
 * The two third parties are the ones the page loads for everybody: Turnstile (the CAPTCHA the app
 * ships with) and the font stylesheet the layout asks for. Neither carries a meal, a session or an
 * address; both are part of the page being tested.
 */
const ALLOWED_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "challenges.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
]);

/** Runs one statement against the local database and returns its output. */
export function sql(query: string, vars: Record<string, string> = {}): string {
  // The query goes in on stdin rather than through -c: psql does not substitute variables in a
  // -c command, so :'name' would reach the server as a syntax error.
  const args = [DB_URL, "-v", "ON_ERROR_STOP=1", "-tA"];
  for (const [name, value] of Object.entries(vars)) args.push("-v", name + "=" + value);
  return execFileSync("psql", args, { input: query, encoding: "utf8" }).trim();
}

/** The sign-up switch, flipped the way the admin page flips it. */
export function setOpenSignups(open: boolean): void {
  sql("update public.app_settings set open_signups = :'flag'", {
    flag: open ? "true" : "false",
  });
}

/** Puts an address on the list, the way an invite does. */
export function invite(email: string): void {
  sql(
    "insert into public.allowed_emails (email) values (:'email') on conflict (email) do nothing",
    { email },
  );
}

/** Takes an address off the list, so a test can start from a clean invitation state. */
export function uninvite(email: string): void {
  sql("delete from public.allowed_emails where lower(email) = lower(:'email')", { email });
}

/**
 * An address nobody else in the suite uses.
 *
 * The project name is part of it because this file runs at both widths, and a phone test that
 * inherited the desktop test account would be testing a signed-in account rather than a new one.
 */
export function freshEmail(prefix: string, project: string): string {
  return prefix + "." + project + "." + Date.now().toString(36) + "@example.com";
}

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function messagesTo(address: string): Promise<MailpitMessage[]> {
  const response = await fetch(MAILPIT_URL + "/api/v1/messages?limit=200");
  const list = (await response.json()) as { messages?: MailpitMessage[] };
  return (list.messages ?? []).filter((message) =>
    message.To.some((to) => to.Address.toLowerCase() === address.toLowerCase()),
  );
}

/** How many messages the local inbox holds for an address. */
export async function mailCount(address: string): Promise<number> {
  return (await messagesTo(address)).length;
}

/**
 * The newest message to an address, waiting for one that arrives after the given count.
 *
 * A count rather than a timestamp because two sends can land inside the same millisecond of a local
 * run, and "the newest one" then answers a question about the wrong email.
 */
export async function mailTo(address: string, after = 0): Promise<Mail> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const messages = await messagesTo(address);
    if (messages.length > after) {
      const newest = messages[0];
      if (newest === undefined) throw new Error("no message to read");
      const response = await fetch(MAILPIT_URL + "/api/v1/message/" + newest.ID);
      const full = (await response.json()) as { Text?: string; HTML?: string };
      return { subject: newest.Subject, text: full.Text ?? "", html: full.HTML ?? "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no email arrived for " + address);
}

/**
 * The verification link out of a message.
 *
 * GoTrue writes one verify URL, and the type in its query decides what clicking it does, so a test
 * asserts the type rather than trusting the subject line.
 */
export function linkOf(mail: Mail, type: string): string {
  const haystack = mail.text === "" ? mail.html : mail.text;
  const pattern = /https?:\/\/[^\s"<>]+\/auth\/v1\/verify[^\s"<>]*/g;
  const links = haystack.match(pattern) ?? [];
  const found = links.find((link) => link.includes("type=" + type));
  if (found === undefined) {
    throw new Error("no " + type + " link in: " + haystack.replace(/<[^>]+>/g, " ").slice(0, 400));
  }
  return decodeURIComponent(found).replace(/&amp;/g, "&");
}

export interface Harness {
  /** Console errors and uncaught exceptions, checked once per test. */
  problems: string[];
  /** Every request the guard refused. */
  blocked: string[];
}

export const test = base.extend<{ harness: Harness }>({
  harness: [
    async ({ context }, use) => {
      const harness: Harness = { problems: [], blocked: [] };

      // "Add NutriTrack to your home screen" arrives a second or two into the phone flow and covers
      // the buttons under it, so a test that meant to press Continue would press the dialog. It is
      // stored as dismissed instead, which is the state every returning visitor is already in: the
      // prompt itself has its own tests in the unit suite.
      await context.addInitScript(() => {
        try {
          window.localStorage.setItem("nutritrack.install.dismissed", "1");
        } catch {
          // A page with no storage (about:blank) has nothing to remember.
        }
      });

      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (ALLOWED_HOSTS.has(url.hostname)) {
          await route.continue();
          return;
        }
        harness.blocked.push(route.request().url());
        await route.abort();
      });

      await use(harness);

      expect(
        harness.blocked,
        "a request left this machine: is the app pointed at the local stack?",
      ).toEqual([]);
      expect(harness.problems, "the page reported errors").toEqual([]);
    },
    { auto: true },
  ],
});

/** Collects the console errors and uncaught exceptions a page produces. */
export function watch(page: Page, harness: Harness): void {
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // A refused request is already reported by the guard above, by URL; the browser adds its own
    // line about it, and counting it twice would say the same thing in two places.
    if (text.includes("ERR_FAILED") || text.includes("Failed to load resource")) return;
    harness.problems.push("console: " + text);
  });
  page.on("pageerror", (error) => {
    harness.problems.push("pageerror: " + error.message);
  });
}

/** Fills the address field and asks the database what this address deserves. */
export async function askState(page: Page, email: string): Promise<void> {
  await page.getByLabel("Email").fill(email);
  // exact, because "Continue with Google" also answers to a prefix match.
  await page.getByRole("button", { name: "Continue", exact: true }).click();
}

/** Signs out from Settings, the way a person does. */
export async function signOut(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
}

export { expect };
