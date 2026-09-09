import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Customer } from "../customers";

const all: Customer[] = [
  { id: "c1", name: "Asha", flat_no: "A-1", mobile: "+919000000001" },
  { id: "c2", name: "Bhau", flat_no: "B-2", mobile: "+919000000002" },
];

const listCustomers = vi.fn(async (): Promise<{ data: Customer[] | null; error: null }> =>
  ({ data: all, error: null }));
const updateCustomer = vi.fn(async (..._a: unknown[]): Promise<{
  error: { code?: string; message?: string } | null;
}> => ({ error: null }));
// The database function is declared `returns table (balance integer, days_left integer)`,
// so PostgREST always hands back an array of rows, never a bare number -- even a
// zero-row array for a customer with no ledger entries yet.
const customerPoints = vi.fn(async (..._a: unknown[]): Promise<{
  data: { balance: number; days_left: number | null }[] | null;
  error: { code?: string; message?: string } | null;
}> => ({ data: [{ balance: 120, days_left: 25 }], error: null }));

vi.mock("../data", () => ({ listCustomers: (...a: unknown[]) => listCustomers(...a) }));
vi.mock("../admin", () => ({
  updateCustomer: (...a: unknown[]) => updateCustomer(...a),
  customerPoints: (...a: unknown[]) => customerPoints(...a),
}));

const { default: Customers } = await import("../screens/Customers");

beforeEach(() => vi.clearAllMocks());

describe("the customers screen", () => {
  it("lists customers", async () => {
    render(<Customers />);
    expect(await screen.findByText(/Asha/)).toBeTruthy();
    expect(screen.getByText(/Bhau/)).toBeTruthy();
  });

  it("filters with the same matcher the bill flow uses", async () => {
    render(<Customers />);
    await screen.findByText(/Asha/);
    fireEvent.change(screen.getByTestId("customer-search"), { target: { value: "B-2" } });
    await waitFor(() => expect(screen.queryByText(/Asha/)).toBeNull());
    expect(screen.getByText(/Bhau/)).toBeTruthy();
  });

  it("shows the points balance when a customer is opened", async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    await waitFor(() => expect(customerPoints).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText(/120/)).toBeTruthy();
  });

  it("distinguishes a failed points lookup from a zero balance", async () => {
    // Zero points is a real answer -- a bill under the first threshold earns none. A
    // failed call is not, and the two must not read alike.
    customerPoints.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    expect(await screen.findByText(/could not be checked|तपासता आले नाहीं|जांचे नहीं/i)).toBeTruthy();
  });

  it("renders a zero balance -- not the failure copy -- when the ledger has no rows", async () => {
    // Zero rows is legitimate: a customer under the vendor's first spend threshold has
    // earned no points and the ledger holds no row for them.
    customerPoints.mockResolvedValueOnce({ data: [], error: null });
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    expect(await screen.findByText(/\b0\b/)).toBeTruthy();
    expect(screen.queryByText(/could not be checked|तपासता आले नाहीं|जांचे नहीं/i)).toBeNull();
  });

  it("drops a stale points response when a second customer is opened first", async () => {
    // Regression for a stale-response race: opening A, then B before A's points call
    // resolves, must not let A's late answer land on B.
    let resolveA: (v: { data: { balance: number; days_left: number | null }[] | null;
      error: { code?: string; message?: string } | null }) => void;
    const aPromise = new Promise<{
      data: { balance: number; days_left: number | null }[] | null;
      error: { code?: string; message?: string } | null;
    }>((resolve) => { resolveA = resolve; });
    customerPoints.mockImplementationOnce(() => aPromise);
    customerPoints.mockResolvedValueOnce({ data: [{ balance: 50, days_left: 10 }], error: null });

    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.click(await screen.findByTestId("customer-c2"));
    await screen.findByText(/50/);

    resolveA!({ data: [{ balance: 999, days_left: 1 }], error: null });
    await waitFor(() => expect(customerPoints).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/999/)).toBeNull();
    expect(screen.getByText(/50/)).toBeTruthy();
  });

  it("saves an edit by id", async () => {
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.change(screen.getByTestId("customer-field-flat_no"), { target: { value: "A-9" } });
    fireEvent.click(screen.getByTestId("customer-save"));
    await waitFor(() => expect(updateCustomer)
      .toHaveBeenCalledWith("c1", expect.objectContaining({ flat_no: "A-9" })));
  });

  it("refuses to save with a field blanked", async () => {
    // #11 makes all three mandatory, and validateCustomer already reports them at once.
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.change(screen.getByTestId("customer-field-mobile"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("customer-save"));
    await waitFor(() => expect(updateCustomer).not.toHaveBeenCalled());
  });

  it("reports a duplicate mobile in words, not as a constraint violation", async () => {
    // (vendor_id, mobile) is unique and an edit can collide with it exactly as a create
    // can. CustomerStep already handles this on the create path.
    updateCustomer.mockResolvedValueOnce({
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "customers_vendor_id_mobile_key"',
      },
    });
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    fireEvent.change(screen.getByTestId("customer-field-mobile"), { target: { value: "+919000000002" } });
    fireEvent.click(screen.getByTestId("customer-save"));
    expect(await screen.findByTestId("customer-duplicate")).toBeTruthy();
  });

  it("offers no delete", async () => {
    // A customer carries bills and an append-only ledger; a delete cascades the ledger
    // and orphans bills.customer_id.
    render(<Customers />);
    fireEvent.click(await screen.findByTestId("customer-c1"));
    expect(screen.queryByRole("button", { name: /delete|remove|काढून|हटाएं/i })).toBeNull();
  });

  it("says nothing yet on an empty list", async () => {
    listCustomers.mockResolvedValueOnce({ data: [], error: null });
    render(<Customers />);
    expect(await screen.findByText(/no customers yet|अजून ग्राहक नाहीत|कोई ग्राहक नहीं/i)).toBeTruthy();
  });
});
