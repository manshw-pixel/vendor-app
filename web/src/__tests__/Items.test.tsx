import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { AdminItem } from "../admin";

const rows: AdminItem[] = [
  { id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12.5, is_active: true, last_cost: "31.25",
    unit: "kg", low_stock_at: 10, sold: false },
  { id: "i2", name_en: "Beet", name_hi: "चुकंदर", name_mr: "बीट", price: 30, stock_kg: 0, is_active: false, last_cost: null,
    unit: "kg", low_stock_at: 10, sold: false },
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
    fireEvent.change(screen.getByLabelText(/^stock|^साठा|^स्टॉक/i), { target: { value: "5" } });
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
    fireEvent.change(screen.getByTestId("item-cost"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText(/^stock|^साठा|^स्टॉक/i), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(createItem).toHaveBeenCalledWith("v1", expect.objectContaining({
      name_en: "Carrot", price: 50, cost: 30, stock_kg: 5,
    })));
  });

  it("edits an existing item by id, not by insert", async () => {
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-edit-/))[0]!);
    fireEvent.change(screen.getByLabelText(/^stock|^साठा|^स्टॉक/i), { target: { value: "20" } });
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

  it("shows the last purchase cost, or says there is none", async () => {
    render(<Items />);
    expect((await screen.findByTestId("item-cost-i1")).textContent).toContain("₹31.25");
    expect((await screen.findByTestId("item-cost-i2")).textContent).toContain("No cost yet");
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

  it("shows a unit select defaulting to kg for a new item", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    const select = screen.getByTestId("item-unit") as HTMLSelectElement;
    expect(select.value).toBe("kg");
    expect(select.disabled).toBe(false);
  });

  it("relabels price and stock when the unit changes to piece", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByTestId("item-unit"), { target: { value: "piece" } });
    expect(screen.getByText("Price per piece")).toBeTruthy();
    expect(screen.getByText("Stock (pieces)")).toBeTruthy();
  });

  it("refuses a fractional stock for a piece item", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Coconut" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "नारियल" } });
    fireEvent.change(screen.getByLabelText(/marathi|मराठी/i), { target: { value: "नारळ" } });
    fireEvent.change(screen.getByTestId("item-unit"), { target: { value: "piece" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/pieces/i), { target: { value: "2.5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(screen.getByText(/whole number/i)).toBeTruthy());
    expect(createItem).not.toHaveBeenCalled();
  });

  it("sends the chosen unit and low-stock threshold to createItem", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Coconut" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "नारियल" } });
    fireEvent.change(screen.getByLabelText(/marathi|मराठी/i), { target: { value: "नारळ" } });
    fireEvent.change(screen.getByTestId("item-unit"), { target: { value: "piece" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "10" } });
    fireEvent.change(screen.getByTestId("item-cost"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText(/pieces/i), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("item-low_stock_at"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(createItem).toHaveBeenCalledWith("v1", expect.objectContaining({
      unit: "piece", low_stock_at: 5,
    })));
  });

  it("locks the unit select when the item has already been sold", async () => {
    listAllItems.mockResolvedValueOnce({
      data: [{ ...rows[0]!, sold: true }],
      error: null,
    });
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-edit-/))[0]!);
    const select = screen.getByTestId("item-unit") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(screen.getByTestId("item-unit-locked")).toBeTruthy();
  });

  it("shows a dozen row's quantity and low colour, and a fine kg row as not low", async () => {
    listAllItems.mockResolvedValueOnce({
      data: [
        { ...rows[0]!, id: "i4", unit: "dozen", stock_kg: 4, low_stock_at: 6 },
        { ...rows[0]!, id: "i5", unit: "kg", stock_kg: 12.5, low_stock_at: 10 },
      ],
      error: null,
    });
    render(<Items />);
    const dozenText = await screen.findByText((_, el) => el?.textContent === "4 dozen — Low stock");
    expect(dozenText.className).toContain("amber");
    const kgRow = screen.getByTestId(/^item-cost-i5$/).closest("li")!;
    expect(kgRow.textContent).not.toMatch(/Low stock/);
  });

  it("refuses to save a new item with no cost", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByLabelText(/english|इंग्रजी|अंग्रेज़ी/i), { target: { value: "Beet" } });
    fireEvent.change(screen.getByLabelText(/hindi|हिंदी/i), { target: { value: "चुकंदर" } });
    fireEvent.change(screen.getByLabelText(/marathi|मराठी/i), { target: { value: "बीट" } });
    fireEvent.change(screen.getByLabelText(/price|भाव/i), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText(/^stock|^साठा|^स्टॉक/i), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(screen.getByText("A new item needs its cost")).toBeTruthy());
    expect(createItem).not.toHaveBeenCalled();
  });

  it("the cost label follows the unit selector", async () => {
    render(<Items />);
    fireEvent.click(await screen.findByRole("button", { name: /add item|माल जोडा|सामान जोड़ें/i }));
    fireEvent.change(screen.getByTestId("item-unit"), { target: { value: "dozen" } });
    expect(screen.getByText("Cost per dozen")).toBeTruthy();
  });

  it("an existing item may be saved with the cost left blank", async () => {
    render(<Items />);
    fireEvent.click((await screen.findAllByTestId(/^item-edit-/))[0]!);
    fireEvent.change(screen.getByTestId("item-cost"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("item-save"));
    await waitFor(() => expect(updateItem).toHaveBeenCalledWith("i1", expect.objectContaining({ cost: null })));
  });
});
