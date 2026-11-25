/**
 * The Contacts client, against a fake API.
 *
 * No test opens a connection and no test reads a key: the fetch is injected and the
 * responses are literals. What is asserted is the shape of every write, because the
 * dangerous mistakes here are all one field away: an `unsubscribed: false` that
 * quietly revives an opt-out, or a `first_name` that replaces one somebody typed in
 * Resend.
 */
import { describe, expect, it } from "vitest";
import {
  createResendContactsClient,
  ResendContactsError,
  type FetchLike,
} from "../src/resend-contacts";

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers from a function and records every request. */
function fakeFetch(respond: (call: Call) => Response): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: Call = { url, method: init.method ?? "GET", body };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

const AUDIENCE = "audience-1";
const CLIENT = { apiKey: "re_test_key", audienceId: AUDIENCE };

describe("createResendContactsClient", () => {
  it("creates a contact with its name and sends no unsubscribed field", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.method === "GET" ? jsonResponse(404, { message: "not found" }) : jsonResponse(200, {}),
    );

    const outcome = await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "person@one.test",
      firstName: "Aman",
      productEmails: true,
    });

    expect(outcome).toBe("created");
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.body).toEqual({ email: "person@one.test", first_name: "Aman" });
    expect(calls[1]?.body).not.toHaveProperty("unsubscribed");
  });

  it("creates an opted-out person already unsubscribed", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.method === "GET" ? jsonResponse(404, {}) : jsonResponse(200, {}),
    );

    await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "person@one.test",
      firstName: null,
      productEmails: false,
    });

    expect(calls[1]?.body).toEqual({ email: "person@one.test", unsubscribed: true });
  });

  it("never replaces a first name that Resend already holds", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.method === "GET"
        ? jsonResponse(200, { first_name: "Their Name", unsubscribed: false })
        : jsonResponse(200, {}),
    );

    const outcome = await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "person@one.test",
      firstName: "Aman",
      productEmails: true,
    });

    expect(outcome).toBe("unchanged");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("fills a missing first name without touching the subscription", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.method === "GET"
        ? jsonResponse(200, { first_name: null, unsubscribed: false })
        : jsonResponse(200, {}),
    );

    const outcome = await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "person@one.test",
      firstName: "Aman",
      productEmails: true,
    });

    expect(outcome).toBe("named");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({ first_name: "Aman" });
  });

  it("does nothing to a contact that is already unsubscribed, and never resubscribes", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(200, { first_name: "Aman", unsubscribed: true }),
    );

    const outcome = await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "person@one.test",
      firstName: "Aman",
      productEmails: true,
    });

    expect(outcome).toBe("unchanged");
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("turns the contact off, and sends only that one field", async () => {
    const { fetchImpl, calls } = fakeFetch((call) =>
      call.method === "GET"
        ? jsonResponse(200, { first_name: "Aman", unsubscribed: false })
        : jsonResponse(200, {}),
    );

    const outcome = await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "person@one.test",
      firstName: "Aman",
      productEmails: false,
    });

    expect(outcome).toBe("unsubscribed");
    expect(calls[1]?.method).toBe("PATCH");
    expect(calls[1]?.body).toEqual({ unsubscribed: true });
  });

  it("treats already exists as success, because the next run will update it", async () => {
    const { fetchImpl } = fakeFetch((call) =>
      call.method === "GET" ? jsonResponse(404, {}) : jsonResponse(409, { message: "exists" }),
    );

    await expect(
      createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
        email: "person@one.test",
        firstName: null,
        productEmails: true,
      }),
    ).resolves.toBe("exists");
  });

  it("builds the contact URL with the address escaped", async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      jsonResponse(200, { first_name: null, unsubscribed: false }),
    );

    await createResendContactsClient({ ...CLIENT, fetchImpl }).upsert({
      email: "a+b@one.test",
      firstName: null,
      productEmails: true,
    });

    expect(calls[0]?.url).toBe(
      `https://api.resend.com/audiences/${AUDIENCE}/contacts/a%2Bb%40one.test`,
    );
  });

  it("fails without naming the address, even when the API echoes it", async () => {
    const { fetchImpl } = fakeFetch(() =>
      jsonResponse(500, { message: "refused", contact: "person@one.test" }),
    );

    const client = createResendContactsClient({ ...CLIENT, fetchImpl });
    await expect(
      client.upsert({ email: "person@one.test", firstName: null, productEmails: true }),
    ).rejects.toBeInstanceOf(ResendContactsError);

    await client
      .upsert({ email: "person@one.test", firstName: null, productEmails: true })
      .catch((error: unknown) => {
        expect(error instanceof Error ? error.message : String(error)).not.toContain(
          "person@one.test",
        );
      });
  });
});
