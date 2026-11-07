/**
 * The refusal panel's mailto link.
 *
 * Asserted on the string rather than on a click, because a mailto opens whatever the device has
 * registered for mail and jsdom has nothing. The parts that can be wrong without any click are the
 * two the panel promises: the subject the mailbox is searched by, and the body naming the address
 * the person typed.
 */
import { describe, expect, it } from "vitest";
import { INVITE_REQUEST_ADDRESS, inviteRequestMailto } from "./invite-request";

describe("the invite request mailto", () => {
  it("addresses the product, with the subject and the typed email in the body", () => {
    expect(inviteRequestMailto("a@example.com")).toBe(
      `mailto:${INVITE_REQUEST_ADDRESS}?subject=NutriTrack%20invite%20request&body=Please%20invite%20a%40example.com`,
    );
  });

  it("trims what was typed, so a stray space does not reach the message", () => {
    expect(inviteRequestMailto("  a@example.com ")).toContain("Please%20invite%20a%40example.com");
  });

  it("encodes a plus, which is a legal character in an address and not a space", () => {
    expect(inviteRequestMailto("aman+nutritrack@gmail.com")).toContain(
      "Please%20invite%20aman%2Bnutritrack%40gmail.com",
    );
  });

  it("still asks something sensible when the field was emptied", () => {
    expect(inviteRequestMailto("   ")).toContain("body=Please%20send%20me%20an%20invite");
  });
});
