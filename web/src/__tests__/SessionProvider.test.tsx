import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SessionProvider, useSession } from "../components/SessionProvider";
import { recallSession, rememberSession } from "../offline/sessionCache";
import type { AppUserRow } from "../session";

const { getSession, onAuthStateChange, maybeSingle, ownerMaybeSingle } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  maybeSingle: vi.fn(),
  ownerMaybeSingle: vi.fn(),
}));

vi.mock("../supabase", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: table === "platform_owners" ? ownerMaybeSingle : maybeSingle }),
      }),
    }),
  },
}));

function Probe() {
  const s = useSession();
  return <div data-testid="probe">{s.kind}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("SessionProvider", () => {
  it("resolves to ready when app_users has a row", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "a@b.test" } } } });
    maybeSingle.mockResolvedValue({
      data: {
        name: "Manish", role: "admin", vendor_id: "v1",
        vendors: { name: "My Kirana" }, must_change_password: false,
      },
      error: null,
    });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
  });

  it("resolves to unmapped on a clean null row", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "new@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    ownerMaybeSingle.mockResolvedValue({ data: null, error: null });

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

  it("resolves to owner when app_users is null but platform_owners has a row", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "owner@app.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    ownerMaybeSingle.mockResolvedValue({ data: { name: "Manish" }, error: null });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("owner"));
  });

  it("resolves to unmapped when neither app_users nor platform_owners has a row", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "new@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    ownerMaybeSingle.mockResolvedValue({ data: null, error: null });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("unmapped"));
  });

  it("resolves to error when the platform_owners lookup itself fails", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "new@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: null });
    ownerMaybeSingle.mockResolvedValue({ data: null, error: { message: "Failed to fetch", code: undefined } });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("error"));
  });

  const cachedRow = {
    name: "Rita", role: "recorder", vendor_id: "v1",
    vendors: { name: "My Kirana", suspended_at: null }, must_change_password: false,
  } as unknown as AppUserRow;

  it("opens from the cached session when getSession fails on the network", async () => {
    rememberSession("u1", "r@b.test", cachedRow);
    getSession.mockResolvedValue({ data: { session: null }, error: { message: "Failed to fetch" } });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
  });

  it("opens from the cached session when the app_users read fails on the network", async () => {
    rememberSession("u1", "r@b.test", cachedRow);
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "r@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: { message: "Failed to fetch", code: undefined } });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
  });

  it("does not use a cached session belonging to another user", async () => {
    rememberSession("someone-else", "x@b.test", cachedRow);
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "r@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: null, error: { message: "Failed to fetch", code: undefined } });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("error"));
  });

  it("stays signed out with no session and no network error", async () => {
    rememberSession("u1", "r@b.test", cachedRow);
    getSession.mockResolvedValue({ data: { session: null }, error: null });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("signedOut"));
  });

  it("remembers the row after a successful online read", async () => {
    getSession.mockResolvedValue({ data: { session: { user: { id: "u1", email: "r@b.test" } } } });
    maybeSingle.mockResolvedValue({ data: cachedRow, error: null });

    render(<SessionProvider><Probe /></SessionProvider>);

    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("ready"));
    expect(recallSession()).toEqual({ userId: "u1", email: "r@b.test", row: cachedRow });
  });
});
