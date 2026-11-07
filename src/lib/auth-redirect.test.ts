import { describe, expect, it } from "vitest";
import { DEFAULT_REDIRECT, safeRedirect } from "./auth-redirect";

describe("safeRedirect", () => {
  it("keeps a path inside the app", () => {
    expect(safeRedirect("/trends")).toBe("/trends");
    expect(safeRedirect("/trends?range=week")).toBe("/trends?range=week");
  });

  it.each([
    ["https://evil.example", "an absolute URL"],
    ["//evil.example", "a protocol-relative host"],
    ["/\\evil.example", "a backslash that some browsers read as a slash"],
    ["javascript:alert(1)", "a scheme"],
    ["", "an empty string"],
  ])("refuses %s (%s)", (value) => {
    expect(safeRedirect(value)).toBe(DEFAULT_REDIRECT);
  });

  it("falls back when the parameter is missing or not a string", () => {
    expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect(null)).toBe(DEFAULT_REDIRECT);
    expect(safeRedirect(["/trends"])).toBe(DEFAULT_REDIRECT);
  });
});
