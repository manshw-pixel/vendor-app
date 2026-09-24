import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("../supabase", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const dues = await import("../dues");

beforeEach(() => rpc.mockReset());

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
