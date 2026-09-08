import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PendingBill } from "../data";

const listPending = vi.fn(async (..._args: unknown[]): Promise<{ data: PendingBill[] | null; error: null }> => ({
  data: [{ id: "b1", token_no: 7, total: 500, customers: { name: "Asha", flat_no: "A-1" } }],
  error: null,
}));
const completeBill = vi.fn(async (..._args: unknown[]) => ({ error: null }));
const pointsForBill = vi.fn(async (..._args: unknown[]) => ({ data: [] as { points: number }[], error: null }));
vi.mock("../data", () => ({
  listPending: (...a: unknown[]) => listPending(...a),
  completeBill: (...a: unknown[]) => completeBill(...a),
  pointsForBill: (...a: unknown[]) => pointsForBill(...a),
}));

const { default: Pending } = await import("../screens/Pending");

beforeEach(() => vi.clearAllMocks());

describe("the pending queue", () => {
  it("lists a waiting bill by token and customer", async () => {
    render(<Pending />);
    expect(await screen.findByText(/7/)).toBeTruthy();
    expect(screen.getByText(/Asha/)).toBeTruthy();
  });

  it("completes a bill after confirming", async () => {
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1"));
  });

  it("disables the button while the call is in flight", async () => {
    // complete_bill is idempotent, so a double tap is harmless -- but a spinner is
    // cheaper than explaining idempotency to a biller with a queue.
    let release: (v: { error: null }) => void = () => {};
    completeBill.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    await waitFor(() => {
      const b = screen.getByRole("button", { name: /complete/i });
      expect(b).toHaveProperty("disabled", true);
    });
    release({ error: null });
  });

  it("says so plainly when nothing is waiting", async () => {
    listPending.mockResolvedValueOnce({ data: [], error: null });
    render(<Pending />);
    // An empty queue is the normal state of a quiet shop, not an error or a blank box.
    expect(await screen.findByText(/nothing waiting|काही नाही|कुछ नहीं/i)).toBeTruthy();
  });

  it("handles a null customers embed without crashing", async () => {
    listPending.mockResolvedValueOnce({
      data: [{ id: "b2", token_no: 3, total: 120, customers: null }],
      error: null,
    });
    render(<Pending />);
    expect(await screen.findByText(/3/)).toBeTruthy();
  });

  it("shows the points a completion actually wrote to the ledger", async () => {
    pointsForBill.mockResolvedValueOnce({ data: [{ points: 5 }], error: null });
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    expect(await screen.findByText(/5/)).toBeTruthy();
  });

  it("does not claim points for a completion that wrote none", async () => {
    pointsForBill.mockResolvedValueOnce({ data: [], error: null });
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    expect(await screen.findByText(/completed/i)).toBeTruthy();
  });
});
