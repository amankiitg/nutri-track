/**
 * The Gmail transport.
 *
 * Three things are being defended here. That this module **cannot send** anything, which is a
 * property of its source rather than of its behaviour, so one test reads the source. That the
 * refresh token is exchanged once and cached rather than on every draft. And that the credential
 * cannot reach a log or an error, including when the upstream echoes it back.
 *
 * No network: `fetch` is injected.
 */
import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GMAIL_COMPOSE_SCOPE, createGmailDraftClient } from "../src/gmail";
import { isApiError } from "../src/errors";

const CREDENTIALS = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "the-client-secret",
  refreshToken: "1//the-refresh-token",
};

/** Every secret in play, so one assertion can cover all of them. */
const SECRETS = [CREDENTIALS.clientSecret, CREDENTIALS.refreshToken, "access-token-value"];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("the module cannot send", () => {
  it("never calls the send endpoint, and that is checked in the source", () => {
    // A behavioural test cannot prove the absence of a code path. This can, and it is the one
    // guarantee the admin page's promise rests on: an invite is a draft a person sends.
    const source = readFileSync(new URL("../src/gmail.ts", import.meta.url), "utf8");

    expect(source).not.toContain("messages/send");
    expect(source).not.toContain("drafts/send");
    expect(source).not.toMatch(/\.send\(/);
    // The only two endpoints it can reach.
    expect(source).toContain("https://oauth2.googleapis.com/token");
    expect(source).toContain("gmail.googleapis.com/gmail/v1/users/me/drafts");
  });

  it("asks for the compose scope, not full mailbox access", () => {
    expect(GMAIL_COMPOSE_SCOPE).toBe("https://www.googleapis.com/auth/gmail.compose");
    expect(GMAIL_COMPOSE_SCOPE).not.toBe("https://mail.google.com/");
  });
});

describe("createGmailDraftClient", () => {
  let output: string[] = [];
  let spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    output = [];
    const capture = (chunk: unknown) => {
      output.push(String(chunk));
      return true;
    };
    spies = [
      vi.spyOn(process.stdout, "write").mockImplementation(capture as never),
      vi.spyOn(process.stderr, "write").mockImplementation(capture as never),
      vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
        output.push(parts.join(" "));
      }),
      vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
        output.push(parts.join(" "));
      }),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  function noSecretsInOutput(): void {
    const everything = output.join("\n");
    for (const secret of SECRETS) {
      assert.ok(!everything.includes(secret), `a secret reached the output: ${secret}`);
    }
  }

  it("exchanges the refresh token once and reuses the access token", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("oauth2"))
        return jsonResponse(200, { access_token: "access-token-value", expires_in: 3600 });
      return jsonResponse(200, { id: "draft-1" });
    });

    const client = createGmailDraftClient(CREDENTIALS, fetchImpl);
    await client.createDraft(Buffer.from("one"));
    await client.createDraft(Buffer.from("two"));

    expect(calls.filter((url) => url.includes("oauth2"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("drafts"))).toHaveLength(2);
    noSecretsInOutput();
  });

  it("sends the message as base64url, which is what the API accepts", async () => {
    let sent = "";
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("oauth2"))
        return jsonResponse(200, { access_token: "access-token-value", expires_in: 3600 });
      sent = String(init.body);
      return jsonResponse(200, { id: "draft-1" });
    });

    await createGmailDraftClient(CREDENTIALS, fetchImpl).createDraft(Buffer.from("Subject: hi"));

    const raw = JSON.parse(sent) as { message: { raw: string } };
    expect(raw.message.raw).toBe(Buffer.from("Subject: hi").toString("base64url"));
    // base64url specifically: standard base64 uses + and /, which are not safe in this field.
    expect(raw.message.raw).not.toContain("+");
    expect(raw.message.raw).not.toContain("/");
  });

  it("reports a rejected refresh token in words an admin can act on, naming no secret", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "invalid_grant" }));

    await expect(
      createGmailDraftClient(CREDENTIALS, fetchImpl).createDraft(Buffer.from("x")),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.status === 502);

    noSecretsInOutput();
  });

  it("does not log an upstream description, which is the field that could carry anything", async () => {
    // Google does not echo credentials, but a rule that depends on another party's behaviour is
    // not a rule: only the short error code is ever read, never the free-text description.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: `refresh token ${CREDENTIALS.refreshToken} was rejected`,
      }),
    );

    await expect(
      createGmailDraftClient(CREDENTIALS, fetchImpl).createDraft(Buffer.from("x")),
    ).rejects.toThrow();

    noSecretsInOutput();
    expect(output.join("\n")).toContain("invalid_grant");
  });

  it("survives a transport failure without putting the request in the message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(
      createGmailDraftClient(CREDENTIALS, fetchImpl).createDraft(Buffer.from("x")),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isApiError(error) &&
        error.message ===
          "Could not create the draft in Gmail. Nothing was added to the invite list. Check the Google credentials, then try again.",
    );

    noSecretsInOutput();
  });

  it("treats a draft with no id as a failure rather than a success", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes("oauth2")
        ? jsonResponse(200, { access_token: "access-token-value", expires_in: 3600 })
        : jsonResponse(200, {}),
    );

    await expect(
      createGmailDraftClient(CREDENTIALS, fetchImpl).createDraft(Buffer.from("x")),
    ).rejects.toSatisfy((error: unknown) => isApiError(error) && error.status === 502);
  });
});
