import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { VendorConfig } from "../admin";

const config: VendorConfig = {
  points_threshold_1: 600, points_reward_1: 50,
  points_threshold_2: 1000, points_reward_2: 100, redeem_days: 30,
};

const loadVendorConfig = vi.fn(async (..._a: unknown[]): Promise<{
  data: VendorConfig | null; error: null;
}> => ({ data: config, error: null }));
const updateVendorConfig = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));

vi.mock("../admin", () => ({
  loadVendorConfig: (...a: unknown[]) => loadVendorConfig(...a),
  updateVendorConfig: (...a: unknown[]) => updateVendorConfig(...a),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "Admin", role: "admin",
  }),
}));

// This screen now folds Staff in beneath the loyalty form. Staff has its own test file
// (Staff.test.tsx) exercising its behaviour in full; here it is stubbed to a bare marker
// so this file's mocks stay scoped to the loyalty form, exactly as App.test.tsx stubs
// every screen it doesn't test.
vi.mock("../screens/Staff", () => ({ default: () => <div data-testid="screen-staff" /> }));

const { default: Settings } = await import("../screens/Settings");

beforeEach(() => vi.clearAllMocks());

describe("the loyalty settings screen", () => {
  it("loads the vendor's current rules", async () => {
    render(<Settings />);
    await waitFor(() => expect(loadVendorConfig).toHaveBeenCalledWith("v1"));
    const field = await screen.findByTestId("settings-points_threshold_1");
    expect((field as HTMLInputElement).value).toBe("600");
  });

  it("puts no heading of its own above the staff section", async () => {
    // Staff renders its own <h2>Staff</h2> and must, because the router mounts it
    // standalone. A wrapper heading here stacked the same word twice on this page.
    render(<Settings />);
    await screen.findByTestId("screen-staff");
    expect(screen.queryByRole("heading", { name: /^Staff$/i })).toBeNull();
  });

  it("warns that past points are never recalculated", async () => {
    // points_ledger is append-only. A vendor who raises a reward and expects yesterday's
    // customers to benefit is going to be wrong, and the screen is where to say so.
    render(<Settings />);
    expect(await screen.findByTestId("settings-future-only")).toBeTruthy();
  });

  it("saves valid numbers as numbers", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByTestId("settings-points_threshold_1"), {
      target: { value: "700" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(updateVendorConfig).toHaveBeenCalledWith("v1",
      expect.objectContaining({ points_threshold_1: 700, points_reward_1: 50 })));
  });

  it("refuses an inverted pair of targets", async () => {
    render(<Settings />);
    fireEvent.change(await screen.findByTestId("settings-points_threshold_2"), {
      target: { value: "500" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(updateVendorConfig).not.toHaveBeenCalled());
    expect(screen.getByTestId("settings-error-points_threshold_2")).toBeTruthy();
  });

  it("refuses a fractional reward", async () => {
    // points_reward_1 is an integer column; Postgres would truncate 2.5 silently.
    render(<Settings />);
    fireEvent.change(await screen.findByTestId("settings-points_reward_1"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(updateVendorConfig).not.toHaveBeenCalled());
  });

  it("confirms a successful save", async () => {
    render(<Settings />);
    await screen.findByTestId("settings-points_threshold_1");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-saved")).toBeTruthy();
  });

  it("shows the policy refusal when the write is blocked", async () => {
    // A non-admin reaching this screen gets 42501 from vendors_admin_update. The route
    // guard is politeness; this is the actual enforcement surfacing.
    updateVendorConfig.mockResolvedValueOnce({
      error: { code: "42501", message: "row-level security" },
    });
    render(<Settings />);
    await screen.findByTestId("settings-points_threshold_1");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-problem")).toBeTruthy();
    expect(screen.queryByTestId("settings-saved")).toBeNull();
  });

  it("clears a stale policy-refusal banner on the next, client-rejected save", async () => {
    // A prior save failed at the server with 42501, so `problem` is set. The admin then
    // edits a field into something validateSettings rejects and saves again -- that save
    // never reaches the server, so the old "Your role does not allow this." must not
    // still be sitting there implying the server refused a write it never received.
    updateVendorConfig.mockResolvedValueOnce({
      error: { code: "42501", message: "row-level security" },
    });
    render(<Settings />);
    await screen.findByTestId("settings-points_threshold_1");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-problem")).toBeTruthy();

    fireEvent.change(screen.getByTestId("settings-points_reward_1"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByTestId("settings-save"));
    await waitFor(() => expect(screen.queryByTestId("settings-problem")).toBeNull());
    expect(screen.getByTestId("settings-error-points_reward_1")).toBeTruthy();
  });

  it("retracts the saved confirmation when a field is edited afterward", async () => {
    // The green "Saved." banner claims the form matches the server. An edit made after a
    // successful save, without resubmitting, breaks that claim, so it must go away.
    render(<Settings />);
    await screen.findByTestId("settings-points_threshold_1");
    fireEvent.click(screen.getByTestId("settings-save"));
    expect(await screen.findByTestId("settings-saved")).toBeTruthy();

    fireEvent.change(screen.getByTestId("settings-points_threshold_1"), {
      target: { value: "800" },
    });
    expect(screen.queryByTestId("settings-saved")).toBeNull();
  });

  it("refuses to let a null config (RLS filtered the vendor row) present as a blank, savable form", async () => {
    // loadVendorConfig uses .maybeSingle(): zero rows come back as { data: null, error:
    // null }, not as a raised error. If the screen quietly rendered blank inputs, an
    // admin could hit save and overwrite their real configuration with the required-field
    // minimums. It must instead surface a problem and refuse to save.
    loadVendorConfig.mockResolvedValueOnce({ data: null, error: null });
    render(<Settings />);
    await waitFor(() => expect(loadVendorConfig).toHaveBeenCalledWith("v1"));
    expect(await screen.findByTestId("settings-problem")).toBeTruthy();
    expect(screen.queryByTestId("settings-points_threshold_1")).toBeNull();
    expect(screen.queryByTestId("settings-save")).toBeNull();
    expect(updateVendorConfig).not.toHaveBeenCalled();
  });
});
