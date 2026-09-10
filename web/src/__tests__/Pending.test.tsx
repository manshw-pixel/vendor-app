import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { PendingBill } from "../data";

const listPending = vi.fn(async (..._args: unknown[]): Promise<{ data: PendingBill[] | null; error: null }> => ({
  data: [{ id: "b1", token_no: 7, total: 500, customer_id: "c1", customers: { name: "Asha", flat_no: "A-1" } }],
  error: null,
}));
const completeBill = vi.fn(async (..._args: unknown[]) => ({ error: null }));
const pointsForBill = vi.fn(async (..._args: unknown[]): Promise<{
  data: { points: number }[] | null;
  error: { message?: string; code?: string } | null;
}> => ({ data: [], error: null }));
const customerBalance = vi.fn(async (..._a: unknown[]): Promise<{
  data: { balance: number; days_left: number | null }[] | null;
  error: null;
}> => ({ data: [{ balance: 100, days_left: 12 }], error: null }));
vi.mock("../data", () => ({
  listPending: (...a: unknown[]) => listPending(...a),
  completeBill: (...a: unknown[]) => completeBill(...a),
  pointsForBill: (...a: unknown[]) => pointsForBill(...a),
  customerBalance: (...a: unknown[]) => customerBalance(...a),
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
    // completeBill now always takes a second argument -- 0 when there is nothing to
    // redeem -- rather than omitting it. Same claim ("completing sends this bill"),
    // against the new signature.
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", 0));
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
      data: [{ id: "b2", token_no: 3, total: 120, customer_id: null, customers: null }],
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
    expect(screen.queryByText(/checked/i)).toBeNull();
  });

  it("tells the biller when the points read fails, and never as 'no points'", async () => {
    // A failed READ is not an absence of data. The bill genuinely completed -- stock and
    // any points already moved server-side -- so the completion message must still show,
    // but the read failure must be visible too, and must not look like the legitimate
    // zero-points case above.
    pointsForBill.mockResolvedValueOnce({ data: null, error: { message: "network down" } });
    render(<Pending />);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    expect(await screen.findByText(/checked/i)).toBeTruthy();
    // Still tells the biller the bill completed -- the write already happened.
    expect(screen.getByText(/completed/i)).toBeTruthy();
    // Must not read like the legitimate zero-points case: no points-awarded count shown.
    expect(screen.queryByText(/points awarded/i)).toBeNull();
  });
});

describe("redeeming points at the counter", () => {
  it("offers no points input for a walk-in bill", async () => {
    // customer_id is null: there is no loyalty account to spend from.
    listPending.mockResolvedValueOnce({
      data: [{ id: "b1", token_no: 7, total: 500, customer_id: null, customers: null }],
      error: null,
    });
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    expect(screen.queryByTestId("redeem-input")).toBeNull();
  });

  it("offers no points input when the customer has none", async () => {
    customerBalance.mockResolvedValueOnce({ data: [{ balance: 0, days_left: null }], error: null });
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await waitFor(() => expect(customerBalance).toHaveBeenCalled());
    expect(screen.queryByTestId("redeem-input")).toBeNull();
  });

  it("sends the points the biller entered", async () => {
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", 40));
  });

  it("completes with no points when the field is left empty", async () => {
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("redeem-input");
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", 0));
  });

  it("shows the biller what to actually collect", async () => {
    // The number they say out loud. Getting this wrong at the counter is the whole risk of
    // the feature.
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "40" } });
    expect((await screen.findByTestId("redeem-summary")).textContent ?? "").toMatch(/460/);
  });

  it("will not let the biller type more points than the customer has", async () => {
    // The function clamps server-side too, but a form that accepts 500 and then collects a
    // different number than it displayed would be worse than one that refuses to show it.
    // With the default fixture (total 500, balance 100) typing 999 clamps to
    // min(100, floor(500)) = 100, so the summary must read exactly 400 -- an alternation
    // of two wrong numbers would pass on a screen that ignored the clamp entirely.
    render(<Pending />);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "999" } });
    expect((screen.getByTestId("redeem-summary").textContent ?? "")).toMatch(/400/);
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalled());
    const sent = completeBill.mock.calls[0]?.[1] as number;
    expect(sent).toBeLessThanOrEqual(100);
  });
});
