import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn((..._a: unknown[]) => ({ select: () => ({ single: async () => ({ data: { id: "b1" }, error: null }) }) }));
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: 7, error: null }));
const from = vi.fn((..._a: unknown[]) => ({
  insert,
  select: () => ({ order: async () => ({ data: [], error: null }), eq: () => ({ order: async () => ({ data: [], error: null }) }) }),
}));

vi.mock("../supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) } }));

const { createBill, addLines, issueToken } = await import("../data");

beforeEach(() => { insert.mockClear(); rpc.mockClear(); from.mockClear(); });

describe("createBill", () => {
  it("sends vendor_id and status=recording", async () => {
    // vendor_id is NOT NULL with no default; omitting it was a real shipped bug.
    // status must be 'recording' or bills_recorder_insert's WITH CHECK refuses the row.
    await createBill("v1", "c1", "u1");
    expect(from).toHaveBeenCalledWith("bills");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      vendor_id: "v1", customer_id: "c1", recorder_id: "u1", status: "recording",
    }));
  });

  it("never sends a total", async () => {
    // issue_token recomputes the total from the line items precisely because the client
    // cannot be trusted with it. Sending one invites someone to believe it matters.
    await createBill("v1", "c1", "u1");
    expect(insert.mock.calls[0]?.[0]).not.toHaveProperty("total");
  });
});

describe("addLines", () => {
  it("stamps vendor_id on every line and computes line_total", async () => {
    await addLines("v1", "b1", [
      { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2 },
      { itemId: "i2", name: "Beet", unitPrice: 30, qtyKg: 1.5 },
    ]);
    expect(insert).toHaveBeenCalledWith([
      { bill_id: "b1", vendor_id: "v1", item_id: "i1", qty_kg: 2, unit_price: 40, line_total: 80 },
      { bill_id: "b1", vendor_id: "v1", item_id: "i2", qty_kg: 1.5, unit_price: 30, line_total: 45 },
    ]);
  });

  it("does nothing on an empty basket", async () => {
    await addLines("v1", "b1", []);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("issueToken", () => {
  it("calls the function with the parameter name the migration declares", async () => {
    // 0003_functions.sql declares issue_token(p_bill_id uuid). A different key here is
    // a runtime error PostgREST reports as "function not found".
    const r = await issueToken("b1");
    expect(rpc).toHaveBeenCalledWith("issue_token", { p_bill_id: "b1" });
    expect(r.data).toBe(7);
  });
});
