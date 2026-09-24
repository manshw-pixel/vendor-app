import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
// from("customers").select(...).eq("id", ...).maybeSingle() -- each step recorded.
const maybeSingle = vi.fn();
const eq = vi.fn(() => ({ maybeSingle }));
const select = vi.fn(() => ({ eq }));
const from = vi.fn((..._a: unknown[]) => ({ select }));
vi.mock("../supabase", () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a), from: (...a: unknown[]) => from(...a) },
}));

const dues = await import("../dues");

beforeEach(() => {
  rpc.mockReset();
  vi.clearAllMocks();
  maybeSingle.mockResolvedValue({ data: { name: "Asha", flat_no: "A-1", mobile: "9" }, error: null });
});

describe("dues API", () => {
  it("coerces the list's numeric strings and trims dates", async () => {
    rpc.mockResolvedValue({ data: [{ customer_id: "c1", name: "Asha", flat_no: "A-1", mobile: "9",
      balance: "240.50", oldest_unpaid: "2026-09-12" }], error: null });
    const { data } = await dues.loadDuesList();
    expect(rpc).toHaveBeenCalledWith("dues_list");
    expect(data).toEqual([{ customer_id: "c1", name: "Asha", flat_no: "A-1", mobile: "9",
      balance: 240.5, oldest_unpaid: "2026-09-12" }]);
  });

  it("loads a customer's balance and timeline together", async () => {
    rpc.mockImplementation(async (fn: string) => fn === "customer_due"
      ? { data: "160.00", error: null }
      : { data: [{ kind: "repayment", id: "e1", at: "2026-09-24T05:00:00Z", business_date: "2026-09-24",
          amount: "40.00", mode: "cash", note: null, by_name: "Sunil", token_no: null,
          reversed_at: null, reversed_by_name: null, reverse_reason: null, day_closed: false }], error: null });
    const { data } = await dues.loadCustomerDues("c1");
    expect(rpc).toHaveBeenCalledWith("customer_due", { p_customer: "c1" });
    expect(rpc).toHaveBeenCalledWith("customer_dues", { p_customer: "c1" });
    expect(data?.balance).toBe(160);
    expect(data?.entries[0]?.amount).toBe(40);
  });

  it("reads the customer's name, flat and mobile alongside, RLS-scoped with no vendor filter", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const { data } = await dues.loadCustomerDues("c1");
    expect(from).toHaveBeenCalledWith("customers");
    expect(select).toHaveBeenCalledWith("name, flat_no, mobile");
    expect(eq).toHaveBeenCalledTimes(1);
    expect(eq).toHaveBeenCalledWith("id", "c1");
    expect(data?.customer).toEqual({ name: "Asha", flat_no: "A-1", mobile: "9" });
  });

  it("gives customer null when no row is visible, and fails on a customer read error", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await dues.loadCustomerDues("c1")).data?.customer).toBeNull();
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const r = await dues.loadCustomerDues("c1");
    expect(r.data).toBeNull();
    expect(r.error).toEqual({ message: "boom" });
  });

  it("sends the writers' parameter names exactly, with a blank note as null", async () => {
    rpc.mockResolvedValue({ data: {}, error: null });
    await dues.recordRepayment("c1", 40, "upi", "  ");
    expect(rpc).toHaveBeenCalledWith("record_repayment",
      { p_customer: "c1", p_amount: 40, p_mode: "upi", p_note: null });
    await dues.recordOpeningBalance("c1", 500, " khata ");
    expect(rpc).toHaveBeenCalledWith("record_opening_balance", { p_customer: "c1", p_amount: 500, p_note: "khata" });
    await dues.reverseDuesEntry("e1", " typo ");
    expect(rpc).toHaveBeenCalledWith("reverse_dues_entry", { p_entry: "e1", p_reason: "typo" });
    await dues.assignCreditCustomer("b1", "c1");
    expect(rpc).toHaveBeenCalledWith("assign_credit_customer", { p_bill: "b1", p_customer: "c1" });
  });
});
