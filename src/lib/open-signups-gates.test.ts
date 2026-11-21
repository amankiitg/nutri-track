/**
 * The two halves of the switch, from the source tree outward.
 *
 * The bug this guards against is not a typo, it is a *second* gate: sign-ups were opened in the
 * sign-in answer and every post-login check still read the invite list, so a brand new account was
 * shown "invite-only". These tests read the files rather than the running app, because the failure
 * was spread across SQL and screens and no single component could see it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = process.cwd();

/** Every migration, in the order they apply. */
function migrations(): Array<{ name: string; sql: string }> {
  const dir = join(REPO, "supabase", "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

/** The body of the last definition of a function, which is the one that ships. */
function lastDefinition(files: Array<{ name: string; sql: string }>, fn: string): string {
  let found: string | null = null;
  for (const file of files) {
    const pattern = new RegExp(
      String.raw`create\s+(?:or\s+replace\s+)?function\s+public\.${fn}\s*\([^)]*\)[\s\S]*?\$\$([\s\S]*?)\$\$`,
      "gi",
    );
    for (const match of file.sql.matchAll(pattern)) {
      if (match[1] !== undefined) found = match[1];
    }
  }
  if (found === null) throw new Error(`no definition of ${fn} found in the migrations`);
  return found;
}

describe("the database gates", () => {
  it("answer from the switch as well as the invite list", () => {
    const files = migrations();

    for (const fn of ["is_email_allowed", "check_email_allowed"]) {
      const body = lastDefinition(files, fn);
      expect(body, `${fn} must consult open_signups`).toContain("open_signups");
    }
  });

  it("refuse to record an invite request while the switch is on", () => {
    const files = migrations();
    const text = files.map((file) => file.sql).join("\n");

    expect(text).toContain("invite_requests_skip_when_open");
    expect(text).toMatch(/if public\.open_signups\(\) then[\s\S]{0,80}return null;/);
  });
});

describe("the client", () => {
  it("never reads the invite list outside the admin tooling", () => {
    const root = join(REPO, "src");
    const offenders: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
        if (entry.includes(".test.")) continue;
        // The admin screens list who was invited; that is the one legitimate reader.
        if (path.endsWith(join("lib", "admin.ts"))) continue;

        const text = readFileSync(path, "utf8");
        if (/from\(\s*["']allowed_emails["']\s*\)/.test(text)) {
          offenders.push(path.slice(root.length + 1));
        }
      }
    }

    walk(root);
    expect(offenders).toEqual([]);
  });

  it("asks the switch, not the list, about an address on the sign-in screen", () => {
    const lib = readFileSync(join(REPO, "src", "lib", "profile.ts"), "utf8");
    // The one gate the layout calls: it reads the database function, which now includes the
    // switch, rather than the table.
    expect(lib).toContain('rpc("is_email_allowed")');
  });
});

describe("the sign-in answer", () => {
  it("distinguishes an account with a password from one that never set one", () => {
    const files = migrations();
    const body = lastDefinition(files, "auth_entry_state");

    // Without these two, an account created by a magic link is shown a password box it can never
    // satisfy, which is exactly the bug this guards.
    expect(body).toContain("'link_only'");
    expect(body).toContain("'has_password'");
    expect(body).toContain("encrypted_password");
    // An account with a link and Google gets both doors, so the answer has to name that case.
    expect(body).toContain("'link_only_google'");
  });
});

describe("the settings page", () => {
  it("still mounts the Account card, where the password control lives", () => {
    const route = readFileSync(
      join(process.cwd(), "src", "routes", "_authenticated", "settings.tsx"),
      "utf8",
    );
    // A component tested in isolation is not a screen: the password control exists only if this
    // page renders the card that holds it.
    expect(route).toContain("<AccountSection");
    expect(route).toContain('from "@/components/settings/AccountSection"');
  });
});
