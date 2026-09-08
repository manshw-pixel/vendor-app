import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import App from "../App";

const { getSession, onAuthStateChange } = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));

vi.mock("../supabase", () => ({
  supabase: {
    auth: { getSession, onAuthStateChange, signOut: vi.fn() },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn() }) }) }),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});
