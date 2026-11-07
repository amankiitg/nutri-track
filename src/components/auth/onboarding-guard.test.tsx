/**
 * The wizard's own door.
 *
 * `/onboarding` is client-only, so its `beforeLoad` is the only thing standing between a finished
 * user and the questions they already answered. It is called directly here rather than through a
 * router, because what is under test is the decision: given a session and a profile, where does it
 * send them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  profile: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: h.getUser },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: h.profile }) }) }),
  },
}));

import { Route } from "@/routes/onboarding";

const beforeLoad = (
  Route as unknown as {
    options: { beforeLoad: (args: { location: { href: string } }) => Promise<unknown> };
  }
).options.beforeLoad;

/** `redirect()` throws an object carrying `to`; this reads it either way it is shaped. */
async function destination(): Promise<string | null> {
  try {
    await beforeLoad({ location: { href: "https://tracknutri.app/onboarding" } });
    return null;
  } catch (caught) {
    const redirect = caught as { to?: unknown; options?: { to?: unknown } };
    const to = redirect.to ?? redirect.options?.to;
    return typeof to === "string" ? to : null;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getUser.mockResolvedValue({
    data: { user: { id: "user-1", email: "aman@example.com" } },
    error: null,
  });
});

describe("the onboarding route", () => {
  it("sends a user who already has a profile to Today", async () => {
    h.profile.mockResolvedValue({ data: { user_id: "user-1", display_name: "Aman" }, error: null });

    expect(await destination()).toBe("/today");
  });

  it("lets a user with no profile through to the questions", async () => {
    h.profile.mockResolvedValue({ data: null, error: null });

    // No throw: the wizard renders.
    expect(await destination()).toBeNull();
  });

  it("sends somebody with no session to sign in, carrying the way back", async () => {
    h.getUser.mockResolvedValue({ data: { user: null }, error: { message: "no session" } });

    expect(await destination()).toBe("/auth");
  });
});
