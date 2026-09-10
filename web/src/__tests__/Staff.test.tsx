import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { StaffRow } from "../admin";

const rows: StaffRow[] = [
  { id: "u1", name: "Admin One", role: "admin" },
  { id: "u2", name: "Rina", role: "recorder" },
];

const listStaff = vi.fn(async (): Promise<{ data: StaffRow[] | null; error: null }> =>
  ({ data: rows, error: null }));
const updateStaff = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));
const removeStaff = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));
const createStaff = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));

vi.mock("../admin", () => ({
  listStaff: () => listStaff(),
  updateStaff: (...a: unknown[]) => updateStaff(...a),
  removeStaff: (...a: unknown[]) => removeStaff(...a),
  createStaff: (...a: unknown[]) => createStaff(...a),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "Admin One", role: "admin",
  }),
}));

const { default: Staff } = await import("../screens/Staff");

beforeEach(() => vi.clearAllMocks());

describe("the staff screen", () => {
  it("lists the roster", async () => {
    render(<Staff />);
    expect(await screen.findByText(/Rina/)).toBeTruthy();
    expect(screen.getByText(/Admin One/)).toBeTruthy();
  });

  it("says plainly that adding links an account rather than inviting one", async () => {
    // §6: creating auth accounts is still the Edge Function slice. The form links an
    // account that already exists, and the screen must not read as an invitation.
    render(<Staff />);
    expect(await screen.findByText(/runbook-first-admin/i)).toBeTruthy();
  });

  it("changes someone else's role", async () => {
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-edit-u2"));
    fireEvent.change(screen.getByTestId("staff-role"), { target: { value: "biller" } });
    fireEvent.click(screen.getByTestId("staff-save"));
    await waitFor(() => expect(updateStaff)
      .toHaveBeenCalledWith("u2", expect.objectContaining({ role: "biller" })));
  });

  it("gives the signed-in admin no way to change their own row", async () => {
    // The single action that locks a vendor out of its own tenant.
    render(<Staff />);
    await screen.findByText(/Admin One/);
    expect(screen.queryByTestId("staff-edit-u1")).toBeNull();
    expect(screen.queryByTestId("staff-remove-u1")).toBeNull();
  });

  it("explains why the admin's own row is locked", async () => {
    render(<Staff />);
    expect(await screen.findByTestId("staff-self-locked")).toBeTruthy();
  });

  it("confirms before removing someone", async () => {
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    expect(removeStaff).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("staff-remove-confirm"));
    await waitFor(() => expect(removeStaff).toHaveBeenCalledWith("u2"));
  });

  it("gives the confirm dialog an accessible name", async () => {
    // Commit 1dc5cc4 fixed exactly this on the two existing dialogs; a third must not
    // reintroduce it.
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toBeTruthy();
  });

  it("does not claim the sign-in account is deleted", async () => {
    // removeStaff unlinks the person from the vendor; the SPA holds only the anon key
    // and cannot touch auth.users.
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    expect(screen.getByTestId("staff-remove-body").textContent ?? "").toMatch(
      /not deleted|मिटत नाही|नहीं मिटता/i,
    );
  });

  it("reloads after a removal", async () => {
    render(<Staff />);
    await screen.findByTestId("staff-remove-u2");
    expect(listStaff).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("staff-remove-u2"));
    fireEvent.click(screen.getByTestId("staff-remove-confirm"));
    await waitFor(() => expect(listStaff).toHaveBeenCalledTimes(2));
  });

  it("keeps the person in the list and shows a clear message when removal fails with a foreign-key restriction", async () => {
    // 0001_schema.sql:75-76 -- recorder_id/biller_id on bill_items reference app_users
    // with no ON DELETE clause, i.e. NO ACTION. Deleting anyone who has ever recorded or
    // completed a bill fails with 23503, which is the common case in a working shop, not
    // an edge case.
    removeStaff.mockResolvedValueOnce({
      error: { code: "23503", message: 'update or delete on table "app_users" violates foreign key constraint' },
    });
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-remove-u2"));
    fireEvent.click(screen.getByTestId("staff-remove-confirm"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/काढून टाकता येत नाही|cannot be removed|हटाया नहीं जा सकता/i)).toBeTruthy();
    expect(screen.getByText(/Rina/)).toBeTruthy();
  });
});

describe("adding staff", () => {
  const ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  async function openForm() {
    render(<Staff />);
    fireEvent.click(await screen.findByTestId("staff-add-open"));
  }

  it("links a new person to this vendor", async () => {
    await openForm();
    fireEvent.change(screen.getByTestId("staff-add-id"), { target: { value: ID } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Sunil" } });
    fireEvent.change(screen.getByTestId("staff-add-role"), { target: { value: "biller" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(createStaff)
      .toHaveBeenCalledWith("v1", { id: ID, name: "Sunil", role: "biller" }));
  });

  it("sends the vendor id explicitly -- app_users.vendor_id has no default", async () => {
    // Omitting it is a 23502, and users_admin_write checks it in WITH CHECK.
    await openForm();
    fireEvent.change(screen.getByTestId("staff-add-id"), { target: { value: ID } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Sunil" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(createStaff).toHaveBeenCalled());
    expect(createStaff.mock.calls[0]?.[0]).toBe("v1");
  });

  it("refuses an id that is not a uuid before it reaches the database", async () => {
    await openForm();
    fireEvent.change(screen.getByTestId("staff-add-id"), { target: { value: "sunil@shop" } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Sunil" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    expect(await screen.findByTestId("staff-add-error-id")).toBeTruthy();
    expect(createStaff).not.toHaveBeenCalled();
  });

  it("reloads the roster after a successful add", async () => {
    await openForm();
    expect(listStaff).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByTestId("staff-add-id"), { target: { value: ID } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Sunil" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(listStaff).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId("staff-added")).toBeTruthy();
  });

  it("names the real problem when the account is already linked, and keeps the form filled", async () => {
    // 23505 on app_users_pkey is the likeliest slip: the roster shows names, the form
    // takes ids, so re-adding someone is easy. The generic "this already exists" would
    // not say which account, and losing the typed id would mean fetching it again.
    createStaff.mockResolvedValueOnce({
      error: { code: "23505", message: 'duplicate key value violates unique constraint "app_users_pkey"' },
    });
    await openForm();
    fireEvent.change(screen.getByTestId("staff-add-id"), { target: { value: ID } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Sunil" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    expect(await screen.findByText(/already linked|पहले से|आधीच/i)).toBeTruthy();
    expect((screen.getByTestId("staff-add-id") as HTMLInputElement).value).toBe(ID);
  });

  it("does not claim success when the policy blocks the insert", async () => {
    createStaff.mockResolvedValueOnce({ error: { code: "42501", message: "row-level security" } });
    await openForm();
    fireEvent.change(screen.getByTestId("staff-add-id"), { target: { value: ID } });
    fireEvent.change(screen.getByTestId("staff-add-name"), { target: { value: "Sunil" } });
    fireEvent.click(screen.getByTestId("staff-add-save"));
    await waitFor(() => expect(createStaff).toHaveBeenCalled());
    expect(screen.queryByTestId("staff-added")).toBeNull();
  });
});
