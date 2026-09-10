import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";

const { getSession, onAuthStateChange, appUserRow } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  appUserRow: { value: null as unknown },
}));

vi.mock("../supabase", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange, signOut: vi.fn() },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: appUserRow.value, error: null }) }),
      }),
    }),
  },
}));

// The screens themselves are exercised in their own test files (Items.test.tsx,
// Customers.test.tsx, Staff.test.tsx, Settings.test.tsx); this file only checks that App
// wires the right component to each route, so each screen is stubbed to a bare marker.
vi.mock("../screens/Bill", () => ({ default: () => <div data-testid="screen-bill" /> }));
vi.mock("../screens/Pending", () => ({ default: () => <div data-testid="screen-pending" /> }));
vi.mock("../screens/Items", () => ({ default: () => <div data-testid="screen-items" /> }));
vi.mock("../screens/Customers", () => ({ default: () => <div data-testid="screen-customers" /> }));
vi.mock("../screens/Staff", () => ({ default: () => <div data-testid="screen-staff" /> }));
vi.mock("../screens/Settings", () => ({ default: () => <div data-testid="screen-settings" /> }));
vi.mock("../screens/Completed", () => ({ default: () => <div data-testid="screen-completed" /> }));
vi.mock("../screens/Dashboards", () => ({ default: () => <div data-testid="screen-dashboards" /> }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appUserRow.value = null;
});

describe("App", () => {
  it("renders something -- the exact regression that shipped a blank page at every URL", async () => {
    // Signed out is the simplest branch to render: it should show the login form,
    // never an empty container. (Under Vitest, BASE_URL is "/", not the "./" that broke
    // the real build -- see the vite.config.ts comment -- so this cannot by itself prove
    // the production basename is correct, only that App renders when it should.)
    getSession.mockResolvedValue({ data: { session: null } });

    const { container } = render(<App />);

    await waitFor(() => expect(container.textContent).not.toBe(""));
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
  });

  it("no longer serves a placeholder to an admin", async () => {
    // The three admin routes stopped being stubs in stage 3. This test exists so the
    // "coming soon" copy cannot quietly outlive the screens, as the README's did
    // until c1d2f1e. /dashboards is still a placeholder and is reached only by
    // navigating to it, so the default landing route must show none.
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "admin@shop.test" } } },
    });
    appUserRow.value = { name: "Admin", role: "admin", vendor_id: "v1", vendors: { name: "Shop" } };

    render(<App />);

    expect(screen.queryByText(/coming soon|लवकरच|जल्द/i)).toBeNull();
  });

  it("shows an unlinked person their own user id, which nothing else in the app does", async () => {
    // Settings -> Staff -> Add staff asks an admin to paste this exact value, and this
    // panel is the only place it can be read. Without it the form wants something
    // obtainable only from the Supabase dashboard -- the database access it exists to
    // avoid. The id is the assertion; the copy button is a convenience on top of it.
    getSession.mockResolvedValue({
      data: { session: { user: { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", email: "new@shop.test" } } },
    });
    appUserRow.value = null;

    render(<App />);

    const shown = await screen.findByTestId("session-user-id");
    expect(shown.textContent).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(screen.getByTestId("session-copy-id")).toBeTruthy();
  });

  it("still renders the id when the clipboard is unavailable", async () => {
    // navigator.clipboard is HTTPS-only and can be refused outright. The id is selectable
    // text, so a rejected copy costs a manual select, not the value -- but a throw that
    // escaped would blank the panel and strand the person entirely.
    getSession.mockResolvedValue({
      data: { session: { user: { id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", email: "new@shop.test" } } },
    });
    appUserRow.value = null;
    const clipboard = { writeText: vi.fn(async () => { throw new Error("denied"); }) };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

    try {
      render(<App />);
      fireEvent.click(await screen.findByTestId("session-copy-id"));
      await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
      expect(screen.getByTestId("session-user-id").textContent)
        .toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("no longer serves a placeholder for dashboards", async () => {
    // /dashboards was the last stub. The README's stage-3 claim that it is the only
    // remaining placeholder stops being true in this slice.
    getSession.mockResolvedValue({
      data: { session: { user: { id: "u1", email: "admin@shop.test" } } },
    });
    appUserRow.value = { name: "Admin", role: "admin", vendor_id: "v1", vendors: { name: "Shop" } };

    render(<App />);

    expect(screen.queryByText(/coming soon|लवकरच|जल्द/i)).toBeNull();
  });
});
