import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../data", () => ({
  listItems: vi.fn(async () => ({ data: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 100, is_active: true }], error: null })),
  listCustomers: vi.fn(async () => ({ data: [{ id: "c1", name: "Asha", flat_no: "A-1", mobile: "+9198" }], error: null })),
  createCustomer: vi.fn(),
  findCustomerByMobile: vi.fn(),
  createBill: vi.fn(async () => ({ data: { id: "b1" }, error: null })),
  addLines: vi.fn(async () => ({ error: null })),
  billHasLines: vi.fn(async () => ({ data: [], error: null })),
  issueToken: vi.fn(async () => ({ data: 7, error: null })),
  billToken: vi.fn(async () => ({ data: null, error: null })),
}));

vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ kind: "ready", userId: "u1", vendorId: "v1", vendorName: "V", name: "R", role: "recorder" }),
}));

const { default: Bill } = await import("../screens/Bill");
const data = await import("../data");

beforeEach(() => vi.clearAllMocks());

describe("the bill screen", () => {
  it("offers the items in one dropdown, not a row or tile per item", async () => {
    // The vendor asked for a dropdown. The rows are the thing being replaced, so this
    // asserts their absence as well as the select's presence.
    const { container } = render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    const select = await screen.findByTestId("item-select");
    expect(select.tagName).toBe("SELECT");
    expect(container.querySelector(".grid-cols-2")).toBeNull();
    expect(container.querySelectorAll("[data-testid^='item-row-']").length).toBe(0);
  });

  it("names the price and stock on the option itself", async () => {
    // An <option> cannot be styled, so the figures a recorder chooses on have to be in
    // its text or they are not on screen until after the pick.
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    const option = (await screen.findByTestId("item-select"))
      .querySelector("option[value='i1']") as HTMLOptionElement;
    expect(option.textContent ?? "").toMatch(/Onion|कांदा|प्याज/);
    expect(option.textContent ?? "").toMatch(/40/);
    expect(option.textContent ?? "").toMatch(/100/);
  });

  it("starts with nothing chosen, so no weight field is waiting", async () => {
    // A select defaulting to the first item would let a mis-tap bill onions the recorder
    // never picked -- the row layout had no such default.
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    await screen.findByTestId("item-select");
    expect(screen.queryByTestId("weight-input")).toBeNull();
  });

  it("keeps the out-of-stock colour on the chosen item, which the option cannot carry", async () => {
    (data.listItems as Mock).mockResolvedValueOnce({
      data: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 0, is_active: true }],
      error: null,
    });
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    const detail = await screen.findByTestId("item-detail");
    expect(detail.querySelector(".text-red-600")).toBeTruthy();
  });

  it("still takes a decimal weight after tapping a row", async () => {
    // Scales report 1.35. The layout changed; the keypad must not.
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    const input = screen.getByTestId("weight-input") as HTMLInputElement;
    expect(input.getAttribute("inputmode")).toBe("decimal");
    fireEvent.change(input, { target: { value: "1.35" } });
    expect(input.value).toBe("1.35");
  });

  it("issues a token through the full flow", async () => {
    render(<Bill />);

    // 1. pick the customer
    fireEvent.click(await screen.findByText("Asha"));

    // 2. add a line
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    // the running total is feedback for the recorder. Targeted by test id, because the
    // basket also shows each line's own amount -- a bare /80/ would match either.
    await waitFor(() => expect(screen.getByTestId("running-total").textContent).toMatch(/80/));

    // 3. Done is guarded by a confirm, because the basket freezes afterwards
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    await waitFor(() => expect(data.issueToken).toHaveBeenCalledWith("b1"));
    expect(data.createBill).toHaveBeenCalledWith("v1", "c1", "u1");
    expect(data.addLines).toHaveBeenCalledWith("v1", "b1", [
      { itemId: "i1", name: expect.any(String), unitPrice: 40, qtyKg: 2 },
    ]);
    expect(await screen.findByText("7")).toBeTruthy();
  });

  it("will not issue a token for an empty basket", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    expect(screen.getByRole("button", { name: /done/i })).toHaveProperty("disabled", true);
    expect(data.issueToken).not.toHaveBeenCalled();
  });

  it("rejects a weight with more precision than the column stores", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "1.234" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(await screen.findByText(/two decimal places|दोन|दो/i)).toBeTruthy();
  });

  // The four cases below guard requirements a later change could quietly undo. Each one
  // fails on the regression it names, not merely on a rewrite.

  it("creates no bill until the confirm is accepted -- an abandoned basket leaves no row", async () => {
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    // The dialog is open and nothing has been written.
    expect(await screen.findByRole("button", { name: /issue the token/i })).toBeTruthy();
    expect(data.createBill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));
    await waitFor(() => expect(data.createBill).toHaveBeenCalledTimes(1));
  });

  it("still sells an item at zero stock -- complete_bill clamps the decrement deliberately", async () => {
    (data.listItems as unknown as Mock).mockResolvedValueOnce({
      data: [{ id: "i1", name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", price: 40, stock_kg: 0, is_active: true }],
      error: null,
    });
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));

    const option = (await screen.findByTestId("item-select"))
      .querySelector("option[value='i1']") as HTMLOptionElement;
    expect(option.disabled).toBe(false);

    fireEvent.change(screen.getByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => expect(screen.getByTestId("running-total").textContent).toMatch(/80/));
    expect(screen.getByRole("button", { name: /done/i })).toHaveProperty("disabled", false);
  });

  it("will not issue a token while offline -- a token cannot be promised without the server", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    try {
      render(<Bill />);
      fireEvent.click(await screen.findByText("Asha"));
      fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
      fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
      fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

      await waitFor(() => expect(screen.getByTestId("running-total").textContent).toMatch(/80/));
      expect(screen.getByRole("button", { name: /done/i })).toHaveProperty("disabled", true);
    } finally {
      Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    }
  });

  it("surfaces a failed token, and the retry resumes rather than creating a second bill", async () => {
    (data.issueToken as unknown as Mock).mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "boom" },
    });
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    // The recorder is told something true, and the dialog is out of the way of it.
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /issue the token/i })).toBeNull(),
    );

    // Retry: the bill already exists, so it must be reused, and the lines must not be
    // inserted twice.
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    expect(await screen.findByText("7")).toBeTruthy();
    expect(data.createBill).toHaveBeenCalledTimes(1);
    expect(data.addLines).toHaveBeenCalledTimes(1);
    expect(data.issueToken).toHaveBeenCalledTimes(2);
  });

  it("shows the token when a lost issue_token response actually committed -- read back, not a duplicate", async () => {
    // The scenario Important 1 fixes: issue_token committed server-side (the bill moved
    // to billed with a real token, and the customer was already sent it), but the
    // response was lost. Without the read-back, the recorder sees a failure and a retry
    // would record a second, duplicate bill behind the first.
    (data.issueToken as unknown as Mock).mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "response lost" },
    });
    (data.billToken as unknown as Mock).mockResolvedValueOnce({
      data: { token_no: 7, status: "billed" },
      error: null,
    });

    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    expect(await screen.findByText("7")).toBeTruthy();
    expect(data.billToken).toHaveBeenCalledWith("b1");
    // No second attempt at issuing a token for a bill the server already billed --
    // exactly the duplicate-bill risk this fix exists to remove.
    expect(data.issueToken).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });

  it("says the token is unknown, rather than claiming failure, when the read-back itself fails", async () => {
    (data.issueToken as unknown as Mock).mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "boom" },
    });
    (data.billToken as unknown as Mock).mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "read failed" },
    });

    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    expect(await screen.findByText(/token could not be confirmed|टोकन की पुष्टि|टोकनची खात्री/i)).toBeTruthy();
    // written stays intact so a retry re-runs issueToken and the read-back.
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));
    await waitFor(() => expect(data.issueToken).toHaveBeenCalledTimes(2));
    expect(data.createBill).toHaveBeenCalledTimes(1);
  });

  it("does not insert lines twice on retry when the first addLines actually committed", async () => {
    // The scenario the client-side check exists for: addLines committed in the database
    // but the response was lost, so the client reports failure and linesAdded stays
    // false. Without the pre-insert check, the retry would call addLines a second time
    // and issue_token would double the total. With it, the retry sees the bill already
    // has lines and skips straight to issuing the token.
    (data.addLines as unknown as Mock).mockResolvedValueOnce({
      error: { code: "XX000", message: "response lost" },
    });
    (data.billHasLines as unknown as Mock).mockResolvedValueOnce({
      data: [{ id: "existing-line" }],
      error: null,
    });

    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));
    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();

    // Retry: the check sees rows already there and must not insert again.
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    expect(await screen.findByText("7")).toBeTruthy();
    expect(data.createBill).toHaveBeenCalledTimes(1);
    expect(data.billHasLines).toHaveBeenCalledWith("b1");
    expect(data.addLines).toHaveBeenCalledTimes(1);
  });

  it("closes the basket for good once the token is issued -- the policies freeze it", async () => {
    // Requirement 2, the one-way door. Once issue_token moves the bill to 'billed',
    // bills_recorder_update and bill_items_write both stop applying. A basket left
    // mounted behind the token screen would accept edits the database then refuses,
    // silently, so assert it is genuinely gone rather than merely covered.
    render(<Bill />);
    fireEvent.click(await screen.findByText("Asha"));
    fireEvent.change(await screen.findByTestId("item-select"), { target: { value: "i1" } });
    fireEvent.change(screen.getByLabelText(/weight/i), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    fireEvent.click(screen.getByRole("button", { name: /done/i }));
    fireEvent.click(screen.getByRole("button", { name: /issue the token/i }));

    expect(await screen.findByText("7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /done/i })).toBeNull();
    expect(screen.queryByTestId("running-total")).toBeNull();
    expect(screen.queryByLabelText(/weight/i)).toBeNull();
  });

  it("offers the existing customer when the mobile is already taken, in both branches", async () => {
    // Requirement 9. Both branches were silently broken once: the in-list branch picked
    // the customer without ever showing the message, and the not-in-list branch showed
    // the message with no route to the customer at all.
    const dupe = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"',
    };

    // Branch A: the customer IS in the already-fetched list.
    (data.createCustomer as Mock).mockResolvedValueOnce({ data: null, error: dupe });
    const a = render(<Bill />);
    fireEvent.click(await screen.findByRole("button", { name: /new customer/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Asha" } });
    fireEvent.change(screen.getByLabelText(/^flat no$/i), { target: { value: "A-1" } });
    fireEvent.change(screen.getByLabelText(/^mobile$/i), { target: { value: "+9198" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    // Anchored selectors throughout this case: a loose /name/i also matches the search
    // box labelled "Search by name, flat or mobile", and a loose matcher shaping a test
    // is how the running-total assertion went wrong earlier.
    expect(await screen.findByText(/already exists/i)).toBeTruthy();
    // The OFFER specifically, not any occurrence of the name -- the customer list behind
    // the form also renders "Asha", so a bare text match would pass without an offer.
    expect((await screen.findByTestId("duplicate-offer")).textContent).toMatch(/Asha/);
    expect(data.findCustomerByMobile).not.toHaveBeenCalled();
    a.unmount();

    // Branch B: the customer is NOT in the fetched list, so it must be fetched by mobile.
    // This is the branch whose comment used to claim the recorder "can still find it by
    // searching" -- which was false, since matchCustomers filters the fetched array.
    (data.createCustomer as Mock).mockResolvedValueOnce({ data: null, error: dupe });
    (data.findCustomerByMobile as Mock).mockResolvedValueOnce({
      data: { id: "c9", name: "Ravi", flat_no: "B-9", mobile: "+9199" },
      error: null,
    });
    render(<Bill />);
    fireEvent.click(await screen.findByRole("button", { name: /new customer/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Ravi" } });
    fireEvent.change(screen.getByLabelText(/^flat no$/i), { target: { value: "B-9" } });
    fireEvent.change(screen.getByLabelText(/^mobile$/i), { target: { value: "+9199" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(data.findCustomerByMobile).toHaveBeenCalledWith("+9199"));
    expect(await screen.findByText(/already exists/i)).toBeTruthy();
    expect((await screen.findByTestId("duplicate-offer")).textContent).toMatch(/Ravi/);
  });

  it("tells the recorder the lookup failed, not that the customer is absent", async () => {
    // Important 2: found.error was never read, so a failed lookup rendered identically to
    // an absent row. Mutating the fix back to `if (found.data) ... else absent` must make
    // this fail -- the absent-row message must not appear, and an error must.
    const dupe = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"',
    };
    (data.createCustomer as Mock).mockResolvedValueOnce({ data: null, error: dupe });
    (data.findCustomerByMobile as Mock).mockResolvedValueOnce({
      data: null,
      error: { code: "XX000", message: "boom" },
    });

    render(<Bill />);
    fireEvent.click(await screen.findByRole("button", { name: /new customer/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "Ravi" } });
    fireEvent.change(screen.getByLabelText(/^flat no$/i), { target: { value: "B-9" } });
    fireEvent.change(screen.getByLabelText(/^mobile$/i), { target: { value: "+9199" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy();
    expect(screen.queryByText(/cannot be shown here|यहां नहीं दिखाया|इथे दाखवता येत नाही/i)).toBeNull();
    expect(screen.queryByTestId("duplicate-offer")).toBeNull();
  });
});
