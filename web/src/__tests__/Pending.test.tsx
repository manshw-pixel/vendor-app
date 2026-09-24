import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PendingBill } from "../data";

const listPending = vi.fn(async (..._args: unknown[]): Promise<{ data: PendingBill[] | null; error: null }> => ({
  data: [{ id: "b1", token_no: 7, total: 500, customer_id: "c1", customers: { name: "Asha", flat_no: "A-1" } }],
  error: null,
}));
const completeBill = vi.fn(async (..._args: unknown[]): Promise<{ error: { message?: string; code?: string } | null }> => ({ error: null }));
const billToken = vi.fn(async (..._args: unknown[]): Promise<{
  data: { token_no: number; status: string } | null;
  error: { message?: string; code?: string } | null;
}> => ({ data: null, error: null }));
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
  billToken: (...a: unknown[]) => billToken(...a),
}));

const loadCustomerDue = vi.fn(async (..._a: unknown[]): Promise<{ data: number | null; error: null }> =>
  ({ data: 0, error: null }));
vi.mock("../dues", () => ({ loadCustomerDue: (...a: unknown[]) => loadCustomerDue(...a) }));

let sessionRole: "admin" | "recorder" | "biller" = "admin";
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({
    kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: sessionRole,
  }),
}));

const { default: Pending } = await import("../screens/Pending");

function renderPending({ role }: { role: "admin" | "recorder" | "biller" } = { role: "admin" }) {
  sessionRole = role;
  return render(<MemoryRouter><Pending /></MemoryRouter>);
}

beforeEach(() => vi.clearAllMocks());

describe("the pending queue", () => {
  it("lists a waiting bill by token and customer", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    expect(await screen.findByText(/7/)).toBeTruthy();
    expect(screen.getByText(/Asha/)).toBeTruthy();
  });

  it("completes a bill after confirming", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    // completeBill now always takes a second argument -- 0 when there is nothing to
    // redeem -- rather than omitting it. Same claim ("completing sends this bill"),
    // against the new signature.
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "cash", 0));
  });

  it("disables the button while the call is in flight", async () => {
    // complete_bill is idempotent, so a double tap is harmless -- but a spinner is
    // cheaper than explaining idempotency to a biller with a queue.
    let release: (v: { error: null }) => void = () => {};
    completeBill.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    await waitFor(() => {
      const b = screen.getByRole("button", { name: /complete/i });
      expect(b).toHaveProperty("disabled", true);
    });
    release({ error: null });
  });

  it("says so plainly when nothing is waiting", async () => {
    listPending.mockResolvedValueOnce({ data: [], error: null });
    render(<MemoryRouter><Pending /></MemoryRouter>);
    // An empty queue is the normal state of a quiet shop, not an error or a blank box.
    expect(await screen.findByText(/nothing waiting|काही नाही|कुछ नहीं/i)).toBeTruthy();
  });

  it("handles a null customers embed without crashing", async () => {
    listPending.mockResolvedValueOnce({
      data: [{ id: "b2", token_no: 3, total: 120, customer_id: null, customers: null }],
      error: null,
    });
    render(<MemoryRouter><Pending /></MemoryRouter>);
    expect(await screen.findByText(/3/)).toBeTruthy();
  });

  it("shows the points a completion actually wrote to the ledger", async () => {
    pointsForBill.mockResolvedValueOnce({ data: [{ points: 5 }], error: null });
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    expect(await screen.findByText(/5/)).toBeTruthy();
  });

  it("does not claim points for a completion that wrote none", async () => {
    pointsForBill.mockResolvedValueOnce({ data: [], error: null });
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
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
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /complete/i }));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByRole("button", { name: /complete this bill|yes/i }));
    expect(await screen.findByText(/checked/i)).toBeTruthy();
    // Still tells the biller the bill completed -- the write already happened.
    expect(screen.getByText(/completed/i)).toBeTruthy();
    // Must not read like the legitimate zero-points case: no points-awarded count shown.
    expect(screen.queryByText(/points awarded/i)).toBeNull();
  });

  it("keeps Complete disabled until a payment mode is picked, then sends it", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    const accept = screen.getByTestId("pending-confirm-b1");
    expect(accept).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("pay-mode-upi"));
    expect(screen.getByTestId("pay-mode-upi").getAttribute("aria-pressed")).toBe("true");
    expect(accept).toHaveProperty("disabled", false);
    fireEvent.click(accept);
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "upi", 0));
  });

  it("says 'Complete on credit' when credit is picked", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    fireEvent.click(screen.getByTestId("pay-mode-credit"));
    expect(screen.getByTestId("pending-confirm-b1").textContent).toMatch(/credit/i);
  });

  it("forgets the mode when the dialog is reopened", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /^complete$/i }));
    fireEvent.click(screen.getByTestId("pay-mode-card"));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /^complete$/i }));
    expect(screen.getByTestId("pending-confirm-b1")).toHaveProperty("disabled", true);
  });
});

describe("redeeming points at the counter", () => {
  it("offers no points input for a walk-in bill", async () => {
    // customer_id is null: there is no loyalty account to spend from.
    listPending.mockResolvedValueOnce({
      data: [{ id: "b1", token_no: 7, total: 500, customer_id: null, customers: null }],
      error: null,
    });
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    expect(screen.queryByTestId("redeem-input")).toBeNull();
  });

  it("offers no points input when the customer has none", async () => {
    customerBalance.mockResolvedValueOnce({ data: [{ balance: 0, days_left: null }], error: null });
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await waitFor(() => expect(customerBalance).toHaveBeenCalled());
    expect(screen.queryByTestId("redeem-input")).toBeNull();
  });

  it("sends the points the biller entered", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "cash", 40));
  });

  it("completes with no points when the field is left empty", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("redeem-input");
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "cash", 0));
  });

  it("shows the biller what to actually collect", async () => {
    // The number they say out loud. Getting this wrong at the counter is the whole risk of
    // the feature.
    render(<MemoryRouter><Pending /></MemoryRouter>);
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
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.change(await screen.findByTestId("redeem-input"), { target: { value: "999" } });
    expect((screen.getByTestId("redeem-summary").textContent ?? "")).toMatch(/400/);
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalled());
    const sent = completeBill.mock.calls[0]?.[2] as number;
    expect(sent).toBeLessThanOrEqual(100);
  });
});

describe("the completion read-back after a lost reply", () => {
  it("treats a lost reply on an already-completed bill as success", async () => {
    // complete_bill may have committed and had its reply lost. Bill.tsx already reads back
    // after a lost issue_token reply; this is the same trick in the place it was missing.
    // Reporting failure here is what makes a biller re-record the sale by hand, moving
    // stock twice and awarding points twice.
    completeBill.mockResolvedValueOnce({ error: { message: "Failed to fetch" } });
    billToken.mockResolvedValueOnce({ data: { token_no: 7, status: "done" }, error: null });

    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));

    expect(await screen.findByText(/completed/i)).toBeTruthy();
    expect(screen.queryByText(/no connection|network/i)).toBeNull();
  });

  it("reports a genuine failure when the bill is still billed", async () => {
    completeBill.mockResolvedValueOnce({ error: { message: "Failed to fetch" } });
    billToken.mockResolvedValueOnce({ data: { token_no: 7, status: "billed" }, error: null });

    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));

    expect(await screen.findByText(/no connection|network/i)).toBeTruthy();
    expect(screen.queryByText(/^completed\.$/i)).toBeNull();
  });

  it("says plainly that it does not know when the read-back itself fails", async () => {
    // The honest answer is the useful one: a biller told "we are not sure" checks the
    // completed list, where one told "failed" re-records the sale.
    completeBill.mockResolvedValueOnce({ error: { message: "Failed to fetch" } });
    billToken.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });

    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));

    await screen.findByTestId("pending-completion-unknown");
    // The failure banner stands alongside it -- never in place of it.
    expect(screen.getByText(/no connection|network/i)).toBeTruthy();
  });
});

describe("reaching the receipt after completion", () => {
  it("offers the receipt once the bill is completed", async () => {
    render(<MemoryRouter><Pending /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    // The moment the slip is wanted: the customer is still standing there.
    const link = await screen.findByTestId("pending-receipt-b1");
    expect(link.getAttribute("href")).toBe("/receipt/b1");
  });
});

describe("editing a pending bill from the queue", () => {
  it("offers Edit on a pending bill for an admin", async () => {
    renderPending({ role: "admin" });
    expect(await screen.findByTestId("bill-amend-b1")).toBeTruthy();
  });

  it("offers Edit for a recorder", async () => {
    renderPending({ role: "recorder" });
    expect(await screen.findByTestId("bill-amend-b1")).toBeTruthy();
  });

  it("does not offer Edit to a biller", async () => {
    renderPending({ role: "biller" });
    await screen.findByText(/token 7/i);
    expect(screen.queryByTestId("bill-amend-b1")).toBeNull();
  });
});

describe("credit and dues on completion", () => {
  it("disables Credit on a bill with no customer, with a hint", async () => {
    listPending.mockResolvedValueOnce({
      data: [{ id: "b2", token_no: 8, total: 90, customer_id: null, customers: null }], error: null,
    });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b2"));
    expect(screen.getByTestId("pay-mode-credit")).toHaveProperty("disabled", true);
    // Once a token is issued nobody can add a customer (RLS allows bill edits only while
    // recording, and amend_pending_bill takes lines only), so the hint must not say to.
    expect(screen.getByText("Credit needs a customer, chosen when the bill is recorded")).toBeTruthy();
    expect(screen.getByTestId("pay-mode-cash")).toHaveProperty("disabled", false);
    expect(loadCustomerDue).not.toHaveBeenCalled();
  });

  it("shows what the customer already owes before more credit is given", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 1240, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    expect((await screen.findByTestId("pending-owes")).textContent).toMatch(/Already owes ₹1,240\.00/);
    expect(loadCustomerDue).toHaveBeenCalledWith("c1");
  });

  it("says nothing about dues when the customer owes nothing", async () => {
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await waitFor(() => expect(loadCustomerDue).toHaveBeenCalled());
    expect(screen.queryByTestId("pending-owes")).toBeNull();
  });
});

describe("collecting a previous due with the bill", () => {
  it("offers it only when they owe and the mode is not Credit, pre-filled with what they owe", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 1240, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    expect(screen.queryByTestId("pending-collect")).toBeNull();          // no mode yet
    fireEvent.click(screen.getByTestId("pay-mode-credit"));
    expect(screen.queryByTestId("pending-collect")).toBeNull();          // credit: hidden
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    const box = screen.getByTestId("pending-collect") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(screen.getByTestId("pending-collect-amount")).toHaveProperty("value", "1240");
  });

  it("sends the due and shows the combined total on the button", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 1240, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    fireEvent.click(screen.getByTestId("pay-mode-upi"));
    fireEvent.click(screen.getByTestId("pending-collect"));
    fireEvent.change(screen.getByTestId("pending-collect-amount"), { target: { value: "240" } });
    const confirm = screen.getByTestId("pending-confirm-b1");
    expect(confirm.textContent).toMatch(/Collect ₹740\.00/);            // 500 bill + 240 due
    fireEvent.click(confirm);
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "upi", 0, 240));
  });

  it("will not send more than they owe", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 100, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-collect"));
    fireEvent.change(screen.getByTestId("pending-collect-amount"), { target: { value: "100.01" } });
    expect(screen.getByTestId("pending-confirm-b1")).toHaveProperty("disabled", true);
    expect(screen.getByText(/more than they owe/)).toBeTruthy();
  });

  it("an unticked box sends no due, exactly as before", async () => {
    loadCustomerDue.mockResolvedValueOnce({ data: 100, error: null });
    renderPending({ role: "biller" });
    fireEvent.click(await screen.findByTestId("pending-complete-b1"));
    await screen.findByTestId("pending-owes");
    fireEvent.click(screen.getByTestId("pay-mode-cash"));
    fireEvent.click(screen.getByTestId("pending-confirm-b1"));
    await waitFor(() => expect(completeBill).toHaveBeenCalledWith("b1", "cash", 0));
  });
});
