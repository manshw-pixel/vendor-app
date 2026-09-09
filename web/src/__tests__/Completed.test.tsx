import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { CompletedBill, BillLine } from "../history";

const PAGE_SIZE = 50;

function bill(n: number): CompletedBill {
  return {
    id: `b${n}`,
    token_no: n,
    total: 100 + n,
    completed_at: `2026-09-09T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    customers: { name: `Cust ${n}`, flat_no: `A-${n}` },
  };
}

const listCompleted = vi.fn(async (..._a: unknown[]): Promise<{
  data: CompletedBill[] | null; error: { code?: string; message?: string } | null;
}> => ({ data: [bill(1), bill(2)], error: null }));
const billLines = vi.fn(async (..._a: unknown[]): Promise<{
  data: BillLine[] | null; error: null;
}> => ({
  data: [{
    id: "l1", qty_kg: 2, unit_price: 40, line_total: 80,
    items: { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा" },
  }],
  error: null,
}));

vi.mock("../history", async () => {
  const actual = await vi.importActual<typeof import("../history")>("../history");
  return {
    ...actual,
    PAGE_SIZE,
    listCompleted: (...a: unknown[]) => listCompleted(...a),
    billLines: (...a: unknown[]) => billLines(...a),
  };
});

const { default: Completed } = await import("../screens/Completed");

beforeEach(() => vi.clearAllMocks());

describe("the completed bills screen", () => {
  it("lists completed bills with token, customer and total", async () => {
    render(<Completed />);
    expect(await screen.findByText(/Cust 1/)).toBeTruthy();
    expect(screen.getByText(/₹101\.00/)).toBeTruthy();
  });

  it("says nothing yet, not not allowed, on an empty period", async () => {
    // A policy-filtered read is zero rows, not an error. See errors.ts.
    listCompleted.mockResolvedValueOnce({ data: [], error: null });
    render(<Completed />);
    expect(await screen.findByTestId("completed-empty")).toBeTruthy();
  });

  it("shows a bill's items when a row is opened", async () => {
    render(<Completed />);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    await waitFor(() => expect(billLines).toHaveBeenCalledWith("b1"));
    expect(await screen.findByText(/Onion|कांदा|प्याज/)).toBeTruthy();
  });

  it("hides load-more when the server returned no extra row", async () => {
    // Fewer than PAGE_SIZE + 1 rows means this was the last page.
    render(<Completed />);
    await screen.findByTestId("completed-row-b1");
    expect(screen.queryByTestId("completed-more")).toBeNull();
  });

  it("offers load-more when the server returned the extra row", async () => {
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<Completed />);
    expect(await screen.findByTestId("completed-more")).toBeTruthy();
  });

  it("does not render the extra probe row", async () => {
    // The PAGE_SIZE + 1st row exists only to prove another page exists. Rendering it
    // would show one bill twice once load-more ran.
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<Completed />);
    await screen.findByTestId("completed-more");
    expect(screen.queryByTestId(`completed-row-b${PAGE_SIZE + 1}`)).toBeNull();
  });

  it("resumes from the last rendered row, not the probe row", async () => {
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<Completed />);
    fireEvent.click(await screen.findByTestId("completed-more"));
    await waitFor(() => expect(listCompleted).toHaveBeenCalledTimes(2));
    const cursor = listCompleted.mock.calls[1]?.[1] as { id: string };
    expect(cursor.id).toBe(`b${PAGE_SIZE}`);
  });

  it("refetches from the first page when the date range changes", async () => {
    // A new period must not resume from the old period's cursor.
    render(<Completed />);
    await screen.findByTestId("completed-row-b1");
    fireEvent.click(screen.getByTestId("range-today"));
    await waitFor(() => expect(listCompleted).toHaveBeenCalledTimes(2));
    expect(listCompleted.mock.calls[1]?.[1]).toBeNull();
  });
});
