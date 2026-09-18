import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Movement } from "../stock";

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));

const items = [
  { id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 12, is_active: true },
];
const listItems = vi.fn(async () => ({ data: items, error: null }));
vi.mock("../data", () => ({ listItems: () => listItems() }));

const rows: Movement[] = [{
  id: "m1", item_id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा",
  kind: "wastage", qty_kg: "2.50", unit_cost: null, note: "rotten",
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
  it("lists movements with a signed quantity", async () => {
    render(<Stock />);
    const row = await screen.findByTestId("stock-row-m1");
    expect(row.textContent).toContain("−2.5 kg");
    expect(row.textContent).toContain("rotten");
    expect(row.textContent).toContain("Recorder A");
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

  it("explains an over-stock wastage and shows the current stock", async () => {
    logMovement.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "wastage exceeds stock" } });
    render(<Stock />);
    await screen.findByTestId("stock-row-m1");
    fireEvent.click(screen.getByTestId("stock-kind-wastage"));
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "i1" } });
    fireEvent.change(screen.getByTestId("stock-kg"), { target: { value: "50" } });
    fireEvent.click(screen.getByTestId("stock-submit"));
    const p = await screen.findByTestId("stock-problem");
    expect(p.textContent).toContain("12");
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
    expect(p.textContent).toContain("7.25");
    expect(p.textContent).not.toContain("12 ");
    await waitFor(() => expect(listItems).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByTestId("stock-item"), { target: { value: "" } });
    expect(screen.getByTestId("stock-problem").textContent).toContain("7.25");
  });

  it("clears a stale problem box when a later load succeeds", async () => {
    movementsBetween.mockResolvedValueOnce({ data: null as unknown as Movement[], error: { message: "boom" } } as never);
    render(<Stock />);
    expect(await screen.findByTestId("stock-problem")).toBeTruthy();
    fireEvent.click(screen.getByTestId("range-month"));
    await waitFor(() => expect(screen.queryByTestId("stock-problem")).toBeNull());
  });
});
