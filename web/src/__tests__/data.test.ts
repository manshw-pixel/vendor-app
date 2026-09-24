import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn((..._a: unknown[]) => ({ select: () => ({ single: async () => ({ data: { id: "b1" }, error: null }) }) }));
const rpc = vi.fn(async (..._a: unknown[]) => ({ data: 7, error: null }));
const gt = vi.fn(async (..._a: unknown[]) => ({ data: [], error: null }));
const select = vi.fn((..._a: unknown[]) => ({
  order: async () => ({ data: [], error: null }),
  eq: (..._b: unknown[]) => ({
    order: async () => ({ data: [], error: null }),
    gt: (...c: unknown[]) => gt(...c),
  }),
}));
// bill_items has its own tiny chain -- separate from the shared `select` above, since
// billDraftLines awaits `.select(...).eq(...)` directly instead of chaining further.
type BillItemRow = {
  id: string; qty_kg: number; unit_price: number; line_total: number; item_id: string;
  items: { name_en: string; name_hi: string; name_mr: string; unit: string } | null;
};
const billItemsEq = vi.fn(async (..._a: unknown[]): Promise<{ data: BillItemRow[]; error: null }> =>
  ({ data: [], error: null }));
const billItemsSelect = vi.fn((..._a: unknown[]) => ({ eq: (...b: unknown[]) => billItemsEq(...b) }));

const from = vi.fn((...a: unknown[]) => {
  if (a[0] === "bill_items") return { select: (...b: unknown[]) => billItemsSelect(...b) };
  return { insert, select: (...b: unknown[]) => select(...b) };
});

vi.mock("../supabase", () => ({ supabase: { from: (...a: unknown[]) => from(...a), rpc: (...a: unknown[]) => rpc(...a) } }));

const { listItems, createBill, replaceBillLines, issueToken, completeBill, listPending, pointsForBill, amendPendingBill, billDraftLines } = await import("../data");

beforeEach(() => {
  insert.mockClear(); rpc.mockClear(); from.mockClear(); select.mockClear(); gt.mockClear();
  billItemsEq.mockClear(); billItemsSelect.mockClear();
});

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

describe("replaceBillLines", () => {
  it("sends the basket without any line_total", async () => {
    // line_total is computed in the function. Sending one would be ignored, and having it
    // in the payload would suggest the client's figure still matters.
    await replaceBillLines("b1", [
      { itemId: "i1", name: "Tomato", unitPrice: 40, qtyKg: 2.5, unit: "kg" },
    ]);
    expect(rpc).toHaveBeenCalledWith("replace_bill_lines", {
      p_bill_id: "b1",
      p_lines: [{ item_id: "i1", qty_kg: 2.5, unit_price: 40 }],
    });
  });

  it("does not send a vendor id", async () => {
    // The function reads vendor_id off the bill. Sending one would be a weaker second
    // copy of a value the server already holds authoritatively.
    await replaceBillLines("b1", [
      { itemId: "i1", name: "Tomato", unitPrice: 40, qtyKg: 1, unit: "kg" },
    ]);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["p_bill_id", "p_lines"]);
  });

  it("carries every line of a multi-item basket in order", async () => {
    await replaceBillLines("b1", [
      { itemId: "i1", name: "Tomato", unitPrice: 40, qtyKg: 2.5, unit: "kg" },
      { itemId: "i2", name: "Onion", unitPrice: 32, qtyKg: 1, unit: "kg" },
    ]);
    const args = rpc.mock.calls[0]?.[1] as { p_lines: unknown[] };
    expect(args.p_lines).toEqual([
      { item_id: "i1", qty_kg: 2.5, unit_price: 40 },
      { item_id: "i2", qty_kg: 1, unit_price: 32 },
    ]);
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

describe("the billing data layer, with redemption", () => {
  it("sends the payment mode and the points", async () => {
    await completeBill("b1", "upi", 40);
    expect(rpc).toHaveBeenCalledWith("complete_bill", {
      p_bill_id: "b1", p_payment_mode: "upi", p_redeem_points: 40,
    });
  });

  it("omits the points entirely when none are redeemed", async () => {
    // The function defaults p_redeem_points to 0; sending an explicit 0 is equivalent but
    // sending undefined is not, so the no-redemption path must not send the key at all.
    await completeBill("b1", "cash");
    expect(rpc).toHaveBeenCalledWith("complete_bill", { p_bill_id: "b1", p_payment_mode: "cash" });
  });

  it("asks for the customer id in the pending queue", async () => {
    // The screen needs it to read a balance; PendingBill did not carry one before.
    await listPending();
    expect(select).toHaveBeenCalledWith(expect.stringContaining("customer_id"));
  });

  it("reads only the AWARD rows for a bill, never the redemption rows", async () => {
    // After this feature a redeemed bill carries both its award row and its negative
    // redemption rows under the same bill_id. Summing all of them would under-report what
    // the customer earned, or go negative on a bill that earned nothing.
    await pointsForBill("b1");
    expect(gt).toHaveBeenCalledWith("points", 0);
  });
});

describe("listItems", () => {
  it("selects unit and low_stock_at", async () => {
    await listItems();
    const cols = select.mock.calls[0]?.[0] as string;
    expect(cols).toContain("unit");
    expect(cols).toContain("low_stock_at");
  });
});

describe("amendPendingBill", () => {
  it("sends item_id/qty_kg/unit_price and never a line_total", async () => {
    await amendPendingBill("b1", [
      { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2.5, unit: "kg" },
    ]);
    expect(rpc).toHaveBeenCalledWith("amend_pending_bill", {
      p_bill_id: "b1",
      p_lines: [{ item_id: "i1", qty_kg: 2.5, unit_price: 40 }],
    });
  });
});

describe("billDraftLines", () => {
  it("maps stored rows onto the Draft shape the basket edits", async () => {
    billItemsEq.mockResolvedValueOnce({
      data: [{
        id: "l1", qty_kg: 2, unit_price: 40, line_total: 80, item_id: "i1",
        items: { name_en: "Onion", name_hi: "प्याज", name_mr: "कांदा", unit: "kg" },
      }],
      error: null,
    });
    const { data } = await billDraftLines("b1");
    expect(data).toEqual([
      { itemId: "i1", name: "Onion", unitPrice: 40, qtyKg: 2, unit: "kg" },
    ]);
  });
});
