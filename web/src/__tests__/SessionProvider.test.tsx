import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SessionProvider, useSession } from "../components/SessionProvider";

const { getSession, onAuthStateChange, maybeSingle } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  maybeSingle: vi.fn(),
}));

vi.mock("../supabase", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
  },
}));

function Probe() {
  const s = useSession();
  return <div data-testid="probe">{s.kind}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SessionProvider", () => {
  it("resolves to ready when app_users has a row", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "a@b.test" } } } });
    maybeSingle.mockResolvedValue({
      data: { name: "Manish", role: "admin", vendor_id: "v1", vendors: { name: "My Kirana" } },
      error: null,
    });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
  });

  it("resolves to unmapped on a clean null row", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "new@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: null });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("unmapped"));
  });

  it("resolves to error (not unmapped) on a query failure", async () => {
    // A dropped connection must never be shown as "no staff record exists" -- that is
    // the exact regression this test pins.
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "a@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: { message: "Failed to fetch", code: undefined } });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("error"));
  });
});
