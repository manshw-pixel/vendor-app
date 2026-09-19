import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { VendorSummary } from "../ownerApi";

const rows: VendorSummary[] = [
  { id: "v1", name: "Sharma Veg", created_at: "2026-09-01T10:00:00Z", suspended_at: null,
    staff_count: "3", bills_month: "12", sales_month: "4500.50", last_bill_at: "2026-09-18T09:00:00Z" },
  { id: "v2", name: "Patil Fruits", created_at: "2026-09-02T10:00:00Z", suspended_at: "2026-09-10T10:00:00Z",
    staff_count: "1", bills_month: "0", sales_month: "0", last_bill_at: null },
];

const listVendorSummary = vi.fn(async (): Promise<{
  data: VendorSummary[] | null; error: { message?: string } | null;
}> =>
  ({ data: rows, error: null }));
const createVendor = vi.fn(async (..._a: unknown[]): Promise<{
  error: { key: string; detail: string } | null;
}> => ({ error: null }));
const setVendorSuspended = vi.fn(async (..._a: unknown[]): Promise<{
  error: { key: string; detail: string } | null;
  outcome: { banned: number; failed: number; bans_skipped?: boolean } | null;
}> => ({ error: null, outcome: { banned: 1, failed: 0 } }));
const signOut = vi.fn(async () => ({ error: null }));

vi.mock("../ownerApi", () => ({
  listVendorSummary: () => listVendorSummary(),
  createVendor: (...a: unknown[]) => createVendor(...a),
  setVendorSuspended: (...a: unknown[]) => setVendorSuspended(...a),
}));
vi.mock("../supabase", () => ({ supabase: { auth: { signOut: () => signOut() } } }));
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "owner", userId: "o1", email: "owner@app.test", name: "Manish" }),
}));

const { default: OwnerConsole } = await import("../screens/OwnerConsole");

beforeEach(() => vi.clearAllMocks());

describe("the owner console", () => {
  it("lists shops with counts and state", async () => {
    render(<OwnerConsole />);
    const v1 = await screen.findByTestId("owner-vendor-v1");
    expect(within(v1).getByText("Sharma Veg")).toBeTruthy();
    expect(within(v1).getByText("3 staff")).toBeTruthy();
    expect(within(v1).getByText("12 bills this month")).toBeTruthy();
    expect(within(v1).getByText(/4,500\.50/)).toBeTruthy();
    expect(within(v1).getByText("Active")).toBeTruthy();
    const v2 = screen.getByTestId("owner-vendor-v2");
    expect(within(v2).getByText("Suspended")).toBeTruthy();
    expect(within(v2).getByText("No bills yet")).toBeTruthy();
    expect(screen.getByText("Manish")).toBeTruthy();
    expect(screen.getByTestId("owner-console")).toBeTruthy();
  });

  it("validates the add form, then creates with the exact body", async () => {
    render(<OwnerConsole />);
    await screen.findByTestId("owner-vendor-v1");
    fireEvent.click(screen.getByTestId("owner-add"));
    fireEvent.click(screen.getByTestId("owner-save"));
    expect(screen.getAllByText("This field is required.").length).toBeGreaterThan(0);
    expect(createVendor).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("owner-vendorName"), { target: { value: "New Shop" } });
    fireEvent.change(screen.getByTestId("owner-address"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("owner-phone"), { target: { value: "98200" } });
    fireEvent.change(screen.getByTestId("owner-adminName"), { target: { value: "Asha" } });
    fireEvent.change(screen.getByTestId("owner-email"), { target: { value: "asha@shop.test" } });
    fireEvent.change(screen.getByTestId("owner-password"), { target: { value: "sunflower9" } });
    fireEvent.click(screen.getByTestId("owner-save"));

    await waitFor(() => expect(createVendor).toHaveBeenCalledWith({
      vendor: { name: "New Shop", address: null, phone: "98200" },
      admin: { name: "Asha", email: "asha@shop.test", password: "sunflower9" },
    }));
    expect((await screen.findByTestId("owner-created")).textContent).toContain("New Shop created.");
    await waitFor(() => expect(listVendorSummary).toHaveBeenCalledTimes(2));
  });

  it("shows a create failure in the problem box", async () => {
    createVendor.mockResolvedValueOnce({ error: { key: "error.emailTaken", detail: "x" } });
    render(<OwnerConsole />);
    await screen.findByTestId("owner-vendor-v1");
    fireEvent.click(screen.getByTestId("owner-add"));
    fireEvent.change(screen.getByTestId("owner-vendorName"), { target: { value: "New Shop" } });
    fireEvent.change(screen.getByTestId("owner-adminName"), { target: { value: "Asha" } });
    fireEvent.change(screen.getByTestId("owner-email"), { target: { value: "asha@shop.test" } });
    fireEvent.change(screen.getByTestId("owner-password"), { target: { value: "sunflower9" } });
    fireEvent.click(screen.getByTestId("owner-save"));
    expect(await screen.findByTestId("owner-problem")).toBeTruthy();
  });

  it("suspends after confirmation and reloads", async () => {
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-suspend-v1"));
    expect(screen.getByTestId("owner-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("owner-confirm"));
    await waitFor(() => expect(setVendorSuspended).toHaveBeenCalledWith("v1", "suspend"));
    await waitFor(() => expect(listVendorSummary).toHaveBeenCalledTimes(2));
  });

  it("cancel closes the confirm without acting", async () => {
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-suspend-v1"));
    fireEvent.click(screen.getByTestId("owner-cancel"));
    expect(screen.queryByTestId("owner-confirm")).toBeNull();
    expect(setVendorSuspended).not.toHaveBeenCalled();
  });

  it("offers Reinstate on a suspended shop", async () => {
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-reinstate-v2"));
    fireEvent.click(screen.getByTestId("owner-confirm"));
    await waitFor(() => expect(setVendorSuspended).toHaveBeenCalledWith("v2", "reinstate"));
    expect(screen.queryByTestId("owner-suspend-v2")).toBeNull();
  });

  it("clears a load failure once a later load succeeds", async () => {
    listVendorSummary.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    render(<OwnerConsole />);
    expect(await screen.findByTestId("owner-problem")).toBeTruthy();
    fireEvent.click(screen.getByTestId("owner-add"));
    fireEvent.change(screen.getByTestId("owner-vendorName"), { target: { value: "New Shop" } });
    fireEvent.change(screen.getByTestId("owner-adminName"), { target: { value: "Asha" } });
    fireEvent.change(screen.getByTestId("owner-email"), { target: { value: "asha@shop.test" } });
    fireEvent.change(screen.getByTestId("owner-password"), { target: { value: "sunflower9" } });
    fireEvent.click(screen.getByTestId("owner-save"));
    await screen.findByTestId("owner-vendor-v1");
    expect(screen.queryByTestId("owner-problem")).toBeNull();
  });

  it("keeps a suspend failure visible after the reload", async () => {
    setVendorSuspended.mockResolvedValueOnce({ error: { key: "owner.vendorNotFound", detail: "x" }, outcome: null });
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-suspend-v1"));
    fireEvent.click(screen.getByTestId("owner-confirm"));
    await waitFor(() => expect(listVendorSummary).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("owner-problem").textContent).toContain("That shop no longer exists.");
  });

  it("warns when suspend bans some staff but not all", async () => {
    setVendorSuspended.mockResolvedValueOnce({ error: null, outcome: { banned: 1, failed: 2 } });
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-suspend-v1"));
    fireEvent.click(screen.getByTestId("owner-confirm"));
    expect(await screen.findByTestId("owner-bans-incomplete")).toBeTruthy();
  });

  it("warns when suspend could not even list staff to ban", async () => {
    setVendorSuspended.mockResolvedValueOnce({
      error: null, outcome: { banned: 0, failed: 0, bans_skipped: true },
    });
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-suspend-v1"));
    fireEvent.click(screen.getByTestId("owner-confirm"));
    expect(await screen.findByTestId("owner-bans-incomplete")).toBeTruthy();
  });

  it("does not warn on reinstate even if bans/unbans partly fail", async () => {
    setVendorSuspended.mockResolvedValueOnce({ error: null, outcome: { banned: 0, failed: 1 } });
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-reinstate-v2"));
    fireEvent.click(screen.getByTestId("owner-confirm"));
    await waitFor(() => expect(listVendorSummary).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("owner-bans-incomplete")).toBeNull();
  });

  it("does not warn when suspend fully bans all staff", async () => {
    render(<OwnerConsole />);
    fireEvent.click(await screen.findByTestId("owner-suspend-v1"));
    fireEvent.click(screen.getByTestId("owner-confirm"));
    await waitFor(() => expect(listVendorSummary).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("owner-bans-incomplete")).toBeNull();
  });

  it("signs out", async () => {
    render(<OwnerConsole />);
    fireEvent.click(screen.getByTestId("owner-signout"));
    await waitFor(() => expect(signOut).toHaveBeenCalled());
  });
});
