import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AdminItem } from "../admin";

const rows: AdminItem[] = [
  { id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5, is_active: true },
  { id: "i2", name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट", price: 30, stock_kg: 0, is_active: false },
];

const listAllItems = vi.fn(async (..._a: unknown[]): Promise<{ data: AdminItem[] | null; error: null }> =>
  ({ data: rows, error: null }));
const createItem = vi.fn(async (..._a: unknown[]) => ({ data: { id: "i3" }, error: null }));
const updateItem = vi.fn(async (..._a: unknown[]) => ({ error: null }));
const setItemActive = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));

vi.mock("../admin", () => ({
  listAllItems: (...a: unknown[]) => listAllItems(...a),
  createItem: (...a: unknown[]) => createItem(...a),
  updateItem: (...a: unknown[]) => updateItem(...a),
  setItemActive: (...a: unknown[]) => setItemActive(...a),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "Shop", name: "Admin", role: "admin",
  }),
}));

const { default: Items } = await import("../screens/Items");

beforeEach(() => vi.clearAllMocks());

describe("the items screen", () => {
  it("lists inactive items too", async () => {
    // listItems() hides them from the bill grid; an admin who cannot see a hidden item
    // cannot bring it back.
    render(<Items />);
    expect(await screen.findByText(/Onion|कांदा/)).toBeTruthy();
    expect(screen.getByText(/Beet|बीट/)).toBeTruthy();
  });

  it("shows the price through rupees()", async () => {
    render(<Items />);
    expect(await screen.findByText(/₹40\.00/)).toBeTruthy();
  });

  it("marks a zero-stock item out of stock", async () => {
    render(<Items />);
    expect(await screen.findByText(/out of stock|साठा संपला|स्टॉक खत्म/i)).toBeTruthy();
  });

  it("refuses to save an item missing its Marathi name", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Carrot" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "गाजर" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/stock|साठा|स्टॉक/i), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(createItem).not.toHaveBeenCalled());
  });

  it("creates a complete item with the vendor id", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Carrot" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "गाजर" } });
    fireEvent.change(screen.getByLabelText(/marathi|मराठी/i), { target: { value: "गाजर" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/stock|साठा|स्टॉक/i), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(createItem).toHaveBeenCalledWith("v1", expect.objectContaining({
      name_en: "Carrot", price: 50, stock_kg: 5,
    })));
  });

  it("edits an existing item by id, not by insert", async () => {
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-edit-/))[0]!);
    fireEvent.change(screen.getByLabelText(/stock|साठा|स्टॉक/i), { target: { value: "20" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(updateItem)
      .toHaveBeenCalledWith("i1", expect.objectContaining({ stock_kg: 20 })));
    expect(createItem).not.toHaveBeenCalled();
  });

  it("hides an item rather than deleting it", async () => {
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-toggle-/))[0]!);
    await waitFor(() => expect(setItemActive).toHaveBeenCalledWith("i1", false));
  });

  it("reloads after a change so the list matches the server", async () => {
    render(<Items />);
    await screen.findAllByTestId(/^item-toggle-/);
    expect(listAllItems).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByTestId(/^item-toggle-/)[0]!);
    await waitFor(() => expect(listAllItems).toHaveBeenCalledTimes(2));
  });

  it("says nothing yet, not not allowed, on an empty list", async () => {
    // A policy-filtered read is zero rows, not an error. See errors.ts.
    listAllItems.mockResolvedValueOnce({ data: [], error: null });
    render(<Items />);
    expect(await screen.findByText(/no items yet|अजून माल नाही|कोई सामान नहीं/i)).toBeTruthy();
  });

  it("shows a problem banner when a toggle is rejected", async () => {
    // Regression: toggle() used to call setProblem() BEFORE load(), so load()'s own
    // (null) error clobbered the message and a rejected toggle was completely silent.
    setItemActive.mockResolvedValueOnce({
      error: { code: "42501", message: "new row violates row-level security policy" },
    });
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-toggle-/))[0]!);
    expect(await screen.findByText(/does not allow|परवानगी नाही|अनुमति नहीं/i)).toBeTruthy();
  });
});
