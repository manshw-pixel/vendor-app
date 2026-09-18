import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Movement } from "../stock";

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));

const items = [
  { id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12, unit: "kg", is_active: true },
  { id: "i2", name_en: "Lemon", name_hi: "नींबू", name_mr: "लिंबू", price: 5, stock_kg: 7, unit: "piece", is_active: true },
];
const listItems = vi.fn(async () => ({ data: items, error: null }));
vi.mock("../data", () => ({ listItems: () => listItems() }));

const rows: Movement[] = [{
  id: "m1", item_id: "i2", name_en: "Lemon", name_hi: "नींबू", name_mr: "लिंबू", unit: "piece",
  kind: "purchase", qty_kg: "3", unit_cost: "10.00", note: "rotten",
  created_by_name: "Recorder A", created_at: "2026-09-18T04:00:00Z",
}];
const movementsBetween = vi.fn(async (..._a: unknown[]) => ({ data: rows, error: null }));
const logMovement = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown; error: { code?: string; message?: string; details?: string } | null;
}> => ({ data: {}, error: null }));
vi.mock("../stock", () => ({
  movementsBetween: (...a: unknown[]) => movementsBetween(...a),
  logMovement: (...a: unknown[]) => logMovement(...a),
}));

const { default: Stock } = await import("../screens/Stock");

beforeEach(() => vi.clearAllMocks());

describe("the stock screen", () => {
  it("lists movements with a signed quantity in the item's unit", async () => {
    render(<Stock />);
    const row = await screen.findByTestId("stock-row-m1");
    expect(row.textContent).toContain("+3 pcs");
    expect(row.textContent).toContain("rotten");
    expect(row.textContent).toContain("Recorder A");
  });

  it("shows the cost suffix in the item's unit", async () => {
    render(<Stock />);
    const row = await screen.findByTestId("stock-row-m1");
    expect(row.textContent).toContain("per piece");
  });

  it("logs a purchase with the parsed numbers and reloads the list", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("stock-cost"), { target: { value: "22.50" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    await waitFor(() => expect(logMovement).toHaveBeenCalledWith({
      itemId: "i1", kind: "purchase", qtyKg: 5, unitCost: 22.5, note: "",
    }));
    await waitFor(() => expect(movementsBetween).toHaveBeenCalledTimes(2));
  });

  it("shows the item option's stock in its own unit", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    const option = screen.getByRole("option", { name: /Lemon/ }) as HTMLOptionElement;
    expect(option.textContent).toContain("7 pcs");
  });

  it("labels the quantity and cost fields with the chosen item's unit", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    // No item chosen yet: falls back to kg.
    expect(screen.getByText(/Quantity \(kg\)/)).toBeTruthy();
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i2" } });
    expect(screen.getByText(/Quantity \(pieces\)/)).toBeTruthy();
    expect(screen.getByText(/Cost per piece/)).toBeTruthy();
  });

  it("hides the cost field for a wastage", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.click(screen.getByTestId("stock-kind-wastage"));
    expect(screen.queryByTestId("stock-cost")).toBeNull();
  });

  it("shows a field error and does not call the server for a bad kg", async () => {
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "0" } });
    fireEvent.change(screen.getByTestId("stock-cost"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    expect(await screen.findByTestId("stock-err-qtyKg")).toBeTruthy();
    expect(logMovement).not.toHaveBeenCalled();
  });

  it("explains an over-stock wastage and shows the current stock in the item's unit", async () => {
    logMovement.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "wastage exceeds stock" } });
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.click(screen.getByTestId("stock-kind-wastage"));
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i2" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    const p = await screen.findByTestId("stock-problem");
    expect(p.textContent).toContain("7 pcs");
  });

  it("quotes the kg from the server's error detail, not the list, and refreshes items", async () => {
    logMovement.mockResolvedValueOnce({ data: null,
      error: { code: "P0001", message: "wastage exceeds stock", details: "7.25" } });
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.click(screen.getByTestId("stock-kind-wastage"));
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    const p = await screen.findByTestId("stock-problem");
    expect(p.textContent).toContain("7.25 kg");
    expect(p.textContent).not.toContain("12 ");
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i2" } });
    // The unit is frozen at error time: switching to a piece-sold item afterwards must not
    // turn the quoted kg figure into a piece count.
    expect(screen.getByTestId("stock-problem").textContent).toContain("7.25 kg");
  });

  it("clears a stale problem box when a later load succeeds", async () => {
    movementsBetween.mockResolvedValueOnce({ data: null as unknown as Movement[], error: { message: "boom" } } as never);
    render(<Stock />);
    expect(await screen.findByTestId("stock-problem")).toBeTruthy();
    fireEvent.click(screen.getByTestId("range-month"));
    await waitFor(() => expect(screen.queryByTestId("stock-problem")).toBeNull());
  });
});
