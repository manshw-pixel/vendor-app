import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CompletedBill, BillLine } from "../history";

const PAGE_SIZE = 50;

function bill(n: number, redeemed_points = 0, completed_at?: string): CompletedBill {
  return {
    id: `b${n}`,
    token_no: n,
    total: 100 + n,
    redeemed_points,
    completed_at: completed_at ?? `2026-09-09T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    customers: { name: `Cust ${n}`, flat_no: `A-${n}` },
  };
}

/** A bill completed on the browser's local "today" -- used to exercise the Void button,
 *  which only shows on same-day bills. new Date().toISOString() lands on today regardless
 *  of when the suite runs, unlike a fixed literal. */
function todayBill(n: number): CompletedBill {
  return bill(n, 0, new Date().toISOString());
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
const voidBill = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown; error: { code?: string; message?: string } | null;
}> => ({ data: null, error: null }));
const listVoided = vi.fn(async (..._a: unknown[]): Promise<{
  data: unknown[] | null; error: { code?: string; message?: string } | null;
}> => ({ data: [], error: null }));

vi.mock("../history", async () => {
  const actual = await vi.importActual<typeof import("../history")>("../history");
  return {
    ...actual,
    PAGE_SIZE,
    listCompleted: (...a: unknown[]) => listCompleted(...a),
    billLines: (...a: unknown[]) => billLines(...a),
    voidBill: (...a: unknown[]) => voidBill(...a),
    listVoided: (...a: unknown[]) => listVoided(...a),
  };
});

const { default: Completed } = await import("../screens/Completed");

beforeEach(() => vi.clearAllMocks());

describe("the completed bills screen", () => {
  it("lists completed bills with token, customer and total", async () => {
    render(<MemoryRouter><Completed /></MemoryRouter>);
    expect(await screen.findByText(/Cust 1/)).toBeTruthy();
    expect(screen.getByText(/₹101\.00/)).toBeTruthy();
  });

  it("says nothing yet, not not allowed, on an empty period", async () => {
    // A policy-filtered read is zero rows, not an error. See errors.ts.
    listCompleted.mockResolvedValueOnce({ data: [], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    expect(await screen.findByTestId("completed-empty")).toBeTruthy();
  });

  it("shows a bill's items when a row is opened", async () => {
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    await waitFor(() => expect(billLines).toHaveBeenCalledWith("b1"));
    expect(await screen.findByText(/Onion|कांदा|प्याज/)).toBeTruthy();
  });

  it("hides load-more when the server returned no extra row", async () => {
    // Fewer than PAGE_SIZE + 1 rows means this was the last page.
    render(<MemoryRouter><Completed /></MemoryRouter>);
    await screen.findByTestId("completed-row-b1");
    expect(screen.queryByTestId("completed-more")).toBeNull();
  });

  it("offers load-more when the server returned the extra row", async () => {
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    expect(await screen.findByTestId("completed-more")).toBeTruthy();
  });

  it("does not render the extra probe row", async () => {
    // The PAGE_SIZE + 1st row exists only to prove another page exists. Rendering it
    // would show one bill twice once load-more ran.
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    await screen.findByTestId("completed-more");
    expect(screen.queryByTestId(`completed-row-b${PAGE_SIZE + 1}`)).toBeNull();
  });

  it("resumes from the last rendered row, not the probe row", async () => {
    const full = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => bill(i + 1));
    listCompleted.mockResolvedValueOnce({ data: full, error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-more"));
    await waitFor(() => expect(listCompleted).toHaveBeenCalledTimes(2));
    const cursor = listCompleted.mock.calls[1]?.[1] as { id: string };
    expect(cursor.id).toBe(`b${PAGE_SIZE}`);
  });

  it("refetches from the first page when the date range changes", async () => {
    // A new period must not resume from the old period's cursor.
    render(<MemoryRouter><Completed /></MemoryRouter>);
    await screen.findByTestId("completed-row-b1");
    fireEvent.click(screen.getByTestId("range-today"));
    await waitFor(() => expect(listCompleted).toHaveBeenCalledTimes(2));
    expect(listCompleted.mock.calls[1]?.[1]).toBeNull();
  });

  it("shows the applied points on a redeemed bill, and nothing extra on one that wasn't", async () => {
    // total is the NET collected; redeemed_points is what was spent, so the gross a
    // shopkeeper expects is total + redeemed_points. A bill with no redemption must not
    // gain any extra line -- most bills have none.
    listCompleted.mockResolvedValueOnce({ data: [bill(1, 50), bill(2)], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);

    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    const redeemedLine = await screen.findByTestId("completed-redeemed-b1");
    expect(redeemedLine.textContent).toMatch(/151/);   // gross: 101 + 50
    expect(redeemedLine.textContent).toMatch(/50/);    // points applied
    expect(redeemedLine.textContent).toMatch(/101/);   // net: bill(1).total

    fireEvent.click(screen.getByTestId("completed-row-b1"));
    fireEvent.click(await screen.findByTestId("completed-row-b2"));
    await waitFor(() => expect(billLines).toHaveBeenCalledWith("b2"));
    expect(screen.queryByTestId("completed-redeemed-b2")).toBeNull();
  });

  it("ignores a slow page for a range the user has already moved off", async () => {
    // Same sequence as the dashboard: the slower earlier request must not append the old
    // period's bills to the new one.
    let releaseOld: (v: { data: CompletedBill[] | null; error: null }) => void = () => {};
    listCompleted
      .mockImplementationOnce(() => new Promise((r) => { releaseOld = r; }))
      .mockResolvedValueOnce({ data: [bill(42)], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("range-month"));
    await screen.findByTestId("completed-row-b42");
    releaseOld({ data: [bill(7)], error: null });
    await waitFor(() => expect(screen.queryByTestId("completed-row-b7")).toBeNull());
    expect(screen.getByTestId("completed-row-b42")).toBeTruthy();
  });

  it("links an expanded bill to its receipt", async () => {
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    const link = await screen.findByTestId("completed-receipt-b1");
    expect(link.getAttribute("href")).toBe("/receipt/b1");
  });

  it("offers Void only on a bill completed today", async () => {
    listCompleted.mockResolvedValueOnce({ data: [todayBill(1), bill(2)], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    expect(await screen.findByTestId("completed-void-b1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("completed-row-b2"));
    await waitFor(() => expect(screen.queryByTestId("completed-void-b2")).toBeNull());
  });

  it("requires a reason, then voids and removes the row", async () => {
    listCompleted.mockResolvedValueOnce({ data: [todayBill(1)], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    fireEvent.click(await screen.findByTestId("completed-void-b1"));
    const confirm = screen.getByTestId("void-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("void-reason"), { target: { value: "  wrong customer " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(voidBill).toHaveBeenCalledWith("b1", "wrong customer"));
    await waitFor(() => expect(screen.queryByTestId("completed-row-b1")).toBeNull());
  });

  it("explains a closed window and keeps the row", async () => {
    listCompleted.mockResolvedValueOnce({ data: [todayBill(1)], error: null });
    voidBill.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "void window closed" } });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    fireEvent.click(await screen.findByTestId("completed-void-b1"));
    fireEvent.change(screen.getByTestId("void-reason"), { target: { value: "late" } });
    fireEvent.click(screen.getByTestId("void-confirm"));
    expect(await screen.findByTestId("completed-problem")).toBeTruthy();
    expect(screen.getByTestId("completed-row-b1")).toBeTruthy();
  });

  it("shows the voided bills of the period on demand", async () => {
    listVoided.mockResolvedValueOnce({ data: [{
      id: "v1", token_no: 9, total: 250, completed_at: new Date().toISOString(),
      voided_at: new Date().toISOString(), void_reason: "typed twice",
      customers: { name: "Cust V", flat_no: "B-2" }, app_users: { name: "Biller A" },
    }], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-voided-toggle"));
    const row = await screen.findByTestId("voided-row-v1");
    expect(row.textContent).toContain("typed twice");
    expect(row.textContent).toContain("Biller A");
    expect(row.textContent).toContain("₹250.00");
  });

  it("announces the voided token after a successful void", async () => {
    listCompleted.mockResolvedValueOnce({ data: [todayBill(1)], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    fireEvent.click(await screen.findByTestId("completed-void-b1"));
    fireEvent.change(screen.getByTestId("void-reason"), { target: { value: "wrong item" } });
    fireEvent.click(screen.getByTestId("void-confirm"));
    const done = await screen.findByTestId("void-done");
    expect(done.textContent).toContain("1");
    expect(done.getAttribute("role")).toBe("status");
  });

  it("gives the void reason field an accessible name", async () => {
    listCompleted.mockResolvedValueOnce({ data: [todayBill(1)], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-row-b1"));
    fireEvent.click(await screen.findByTestId("completed-void-b1"));
    expect(screen.getByLabelText(/why is this bill being voided/i)).toBeTruthy();
  });

  it("does not let an older voided-list response overtake a newer one for the same range", async () => {
    let resolveFirst: (v: { data: unknown[]; error: null }) => void = () => {};
    listVoided
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ data: [{
        id: "v2", token_no: 5, total: 100, completed_at: new Date().toISOString(),
        voided_at: new Date().toISOString(), void_reason: "second",
        customers: { name: "Cust 2", flat_no: "A-2" }, app_users: { name: "Biller B" },
      }], error: null });
    render(<MemoryRouter><Completed /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("completed-voided-toggle"));
    fireEvent.click(screen.getByTestId("completed-voided-toggle"));   // close
    fireEvent.click(screen.getByTestId("completed-voided-toggle"));   // reopen -> second call
    await screen.findByTestId("voided-row-v2");
    resolveFirst({ data: [{
      id: "v1", token_no: 1, total: 50, completed_at: new Date().toISOString(),
      voided_at: new Date().toISOString(), void_reason: "first",
      customers: null, app_users: null,
    }], error: null });
    await waitFor(() => expect(screen.queryByTestId("voided-row-v1")).toBeNull());
    expect(screen.getByTestId("voided-row-v2")).toBeTruthy();
  });
});
