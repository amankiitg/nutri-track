import { beforeEach, describe, expect, it, vi } from "vitest";
import { friendlyAuthError, isInvalidCredentials } from "./auth-errors";

beforeEach(() => {
  // The helper logs the raw message on purpose; the tests are about the sentence it returns.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("friendlyAuthError", () => {
  it.each([
    ["Invalid login credentials", /don't match/i],
    ["Email not confirmed", /confirm your email/i],
    ["Email rate limit exceeded", /too many attempts/i],
    ["User already registered", /already have an account/i],
    ["Database error saving new user", /couldn't create the account/i],
    ["Email link is invalid or has expired", /expired or was already used/i],
    ["Failed to fetch", /reach the server/i],
  ])("maps %s to something a person can act on", (raw, expected) => {
    expect(friendlyAuthError({ message: raw })).toMatch(expected);
  });

  it("does not pass an unrecognised message through", () => {
    // The requirement is plain English, not the database's words with a full stop added.
    const sentence = friendlyAuthError({ message: "PGRST301 JWT expired: invalid claim" });

    expect(sentence).not.toContain("PGRST");
    expect(sentence).toMatch(/try again/i);
  });

  it("logs the raw message, which is the part a bug report needs", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    friendlyAuthError({ message: "Invalid login credentials" });

    expect(spy).toHaveBeenCalledWith("[auth]", "Invalid login credentials");
  });

  it("takes a bare string, which is how a URL-provided error arrives", () => {
    expect(friendlyAuthError("access_denied")).toMatch(/cancelled/i);
  });

  it("has an answer when there is no message at all", () => {
    expect(friendlyAuthError(null)).toMatch(/something went wrong/i);
    expect(friendlyAuthError(undefined)).toMatch(/something went wrong/i);
  });
});

/**
 * The sign-in screen asks "is there an invite at all?" only for these failures, so the predicate
 * has to agree with the sentence above it in every case, including the ones it says no to.
 */
describe("isInvalidCredentials", () => {
  it.each([
    ["Invalid login credentials"],
    ["invalid credentials"],
    [{ message: "Invalid login credentials" }],
    [new Error("Invalid login credentials")],
  ])("recognises %s, whatever shape it arrives in", (error) => {
    expect(isInvalidCredentials(error)).toBe(true);
  });

  it.each([
    ["Email not confirmed"],
    ["Email rate limit exceeded"],
    ["Failed to fetch"],
    [null],
    [undefined],
    [""],
  ])("says no to %s, which is not a credentials failure", (error) => {
    expect(isInvalidCredentials(error)).toBe(false);
  });

  it("agrees with the sentence the same error produces", () => {
    // One rule, two readers: if these ever disagree, one screen blames the password while
    // another offers the invite panel for the same failure.
    const error = { message: "Invalid login credentials" };

    expect(friendlyAuthError(error)).toMatch(/don't match/i);
    expect(isInvalidCredentials(error)).toBe(true);
  });
});
