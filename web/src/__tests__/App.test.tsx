import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
});
